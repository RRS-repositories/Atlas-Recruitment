import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pool } from '../lib/db.js';
import {
  ROLES,
  authenticate,
  hashPassword,
  issueToken,
  requireAdmin,
  requireRole,
  usingBootstrap,
} from '../lib/adminAuth.js';
import { resolveCv, cvExists } from '../lib/storage.js';
import { writtenQuestionsFor } from '../lib/roles.js';
import { publicQuestionsFor } from '../lib/questions.js';
import { parseRange, voiceContentType, voiceFilename } from '../lib/voiceDownload.js';
import { generateBookingToken, tokenExpiry } from '../lib/bookingToken.js';
import { notifyCancelledByUs, notifyDecision, notifyMeetingLink, notifyNoShow } from '../lib/notify.js';
import { isDeclineReason, NO_REASON } from '../../shared/declineReasons.js';
import { cancelPendingFor, historyFor } from '../lib/outbox.js';
import { describeTemplates } from '../lib/templates.js';
import { mailMode } from '../lib/mailer.js';
import { captchaMode } from '../lib/captcha.js';
import { llmMode } from '../lib/llm.js';
import { chatMode, chatMissing } from '../lib/chat.js';
import { FLAGS, allFlags, isEnabled, setFlag } from '../lib/flags.js';
import { EMAIL, FIELD_LIMITS } from '../lib/validate.js';
import { addBlackout, listBlackouts, removeBlackout } from '../lib/blackouts.js';
import { dueForDeletion, retentionMonths, setRetentionMonths } from '../lib/retention.js';
import { buildCalendar } from '../lib/calendar.js';
import { markNotAttended, previewNotAttended } from '../lib/notAttended.js';
import { cancelMeetLink } from '../lib/meetLink.js';
import { REBOOK_WARN_HOURS, attendanceGuard, reissueGuard } from '../lib/rebookPolicy.js';

/**
 * The manager's view: read applications, accept or decline them.
 *
 * Every response carries personal data, so nothing here is cacheable and
 * nothing is indexable. Decisions are recorded against the person who made
 * them — the whole reason the admin login is per-manager rather than shared.
 */

const PAGE_SIZE = 25;
const STATUSES = new Set(['pending', 'accepted', 'declined']);

/**
 * The sorts the list will honour. Anything else is newest-first.
 *
 * Sorting happens HERE rather than in the browser because the list is
 * paginated: sorted on the client, "highest score first" would order the
 * twenty-five rows already on screen and quietly mean "the best of page one".
 */
const SORTS = new Set(['score_desc', 'score_asc', 'duration_desc', 'duration_asc']);

/** The AI-check bands a manager can narrow to. `all` is simply no filter. */
const AI_LEVELS = new Set(['clean', 'possible', 'ai_used']);

/*
 * The interview filter: the status of the applicant's latest interview, the
 * same one the list shows on each row (LIST's lateral join, with the same rule
 * about withdrawn re-book links). 'invited' is what the row calls "Link sent".
 * An allow-list like AI_LEVELS; anything else means no narrowing.
 */
const INTERVIEW_FILTERS = new Set(['invited', 'booked', 'no_show']);

const LIST = `
  SELECT a.id, a.created_at, a.role, a.full_name, a.email, a.phone,
         a.rule_score, a.final_score, a.status, a.duration_sec,
         a.ai_use_level, a.ai_use_score, a.ai_use_reasons,
         a.decided_by_email, a.decided_at, a.cv_filename, a.cv_deleted_at,
         -- Through to_jsonb, not by name, so the applicant list -- the page
         -- managers live on -- cannot break if code lands before recruit_015.
         COALESCE((to_jsonb(a) ->> 'do_not_rehire')::boolean, false) AS do_not_rehire,
         to_jsonb(a) ->> 'do_not_rehire_reason' AS do_not_rehire_reason,
         i.status AS interview_status, i.starts_at AS interview_at,
         -- The no-show re-book's chips: whether the latest interview is a final
         -- chance, when its link runs out, and how many interviews were missed.
         -- Same to_jsonb rule as above.
         i.is_final_chance AS interview_final_chance,
         i.token_expires_at AS interview_expires_at,
         (SELECT count(*)::int FROM recruit_interviews n
           WHERE n.applicant_id = a.id AND n.status = 'no_show') AS no_show_count
    FROM recruit_applicants a
    LEFT JOIN LATERAL (
      SELECT li.status, li.starts_at, li.token_expires_at,
             COALESCE((to_jsonb(li) ->> 'is_final_chance')::boolean, false) AS is_final_chance
        FROM recruit_interviews li
       WHERE li.applicant_id = a.id
         -- A re-book link that was withdrawn ("they did attend") or ran out is
         -- not the interview to show: the one it was offered for is. Without
         -- this, correcting a mistaken "Not attended" would leave the row
         -- reading "Cancelled" instead of "Attended". No re-book rows, no
         -- change.
         AND NOT (li.status = 'cancelled' AND to_jsonb(li) ->> 'rebook_of_interview_id' IS NOT NULL)
       ORDER BY li.created_at DESC LIMIT 1
    ) i ON true
   WHERE ($1::recruit_status IS NULL OR a.status = $1)
     AND ($2::recruit_role  IS NULL OR a.role = $2)
     AND ($3::text IS NULL
          OR a.full_name ILIKE '%' || $3 || '%'
          OR a.email::text ILIKE '%' || $3 || '%')
     AND ($6::date IS NULL OR a.created_at >= $6::date)
     AND ($7::date IS NULL OR a.created_at < ($7::date + 1))
     AND ($8::text IS NULL OR a.ai_use_level = $8)
     AND ($10::text IS NULL OR i.status::text = $10)
   ORDER BY
     -- One ORDER BY with the choice as a parameter, rather than SQL built by
     -- string concatenation. $9 can only ever be one of the handful of values
     -- SORTS allows, so this cannot be turned into an injection even if the
     -- allow-list above it were ever removed.
     --
     -- NULLS LAST throughout, deliberately: an applicant whose score or
     -- duration was never recorded should sit at the bottom of either
     -- direction, not float to the top of "lowest first" and look like the
     -- worst candidate.
     CASE WHEN $9 = 'score_desc'    THEN a.final_score  END DESC NULLS LAST,
     CASE WHEN $9 = 'score_asc'     THEN a.final_score  END ASC  NULLS LAST,
     CASE WHEN $9 = 'duration_desc' THEN a.duration_sec END DESC NULLS LAST,
     CASE WHEN $9 = 'duration_asc'  THEN a.duration_sec END ASC  NULLS LAST,
     -- Always the last word, so a page of equal scores keeps a stable order
     -- rather than shuffling between requests and repeating or skipping rows
     -- across pagination.
     a.created_at DESC
   LIMIT $4 OFFSET $5
`;

const COUNT = `
  SELECT count(*)::int AS total
    FROM recruit_applicants a
   WHERE ($1::recruit_status IS NULL OR a.status = $1)
     AND ($2::recruit_role  IS NULL OR a.role = $2)
     AND ($3::text IS NULL
          OR a.full_name ILIKE '%' || $3 || '%'
          OR a.email::text ILIKE '%' || $3 || '%')
     AND ($4::date IS NULL OR a.created_at >= $4::date)
     AND ($5::date IS NULL OR a.created_at < ($5::date + 1))
     AND ($6::text IS NULL OR a.ai_use_level = $6)
     -- The interview filter, on the latest interview as LIST judges it.
     AND ($7::text IS NULL OR (SELECT li.status::text FROM recruit_interviews li
           WHERE li.applicant_id = a.id
             AND NOT (li.status = 'cancelled' AND to_jsonb(li) ->> 'rebook_of_interview_id' IS NOT NULL)
           ORDER BY li.created_at DESC LIMIT 1) = $7)
`;

/**
 * The counts beside the status filters.
 *
 * Scoped by role, search and dates but NOT by status -- the whole point of
 * "Accepted 4" is to tell you what you would get if you clicked it, which a
 * count that already had the status applied could never do.
 */
const TAB_COUNTS = `
  SELECT
    count(*)::int                                      AS total,
    count(*) FILTER (WHERE a.status = 'pending')::int  AS pending,
    count(*) FILTER (WHERE a.status = 'accepted')::int AS accepted,
    count(*) FILTER (WHERE a.status = 'declined')::int AS declined
  FROM recruit_applicants a
  WHERE ($1::recruit_role IS NULL OR a.role = $1)
    AND ($2::text IS NULL
         OR a.full_name ILIKE '%' || $2 || '%'
         OR a.email::text ILIKE '%' || $2 || '%')
    AND ($3::date IS NULL OR a.created_at >= $3::date)
    AND ($4::date IS NULL OR a.created_at < ($4::date + 1))
    -- The AI filter narrows these too, or a pill reading "Accepted 4" would
    -- open a list of two and the numbers on the screen would contradict
    -- each other.
    AND ($5::text IS NULL OR a.ai_use_level = $5)
    -- And the interview filter, for the same reason.
    AND ($6::text IS NULL OR (SELECT li.status::text FROM recruit_interviews li
           WHERE li.applicant_id = a.id
             AND NOT (li.status = 'cancelled' AND to_jsonb(li) ->> 'rebook_of_interview_id' IS NOT NULL)
           ORDER BY li.created_at DESC LIMIT 1) = $6)
`;

// The summary counts every application, not just the filtered page: it is the
// state of the pipeline, and a figure that moved when you typed in the search
// box would be worse than no figure at all. $1 is the page's scope: null on
// /admin (the whole pipeline, as it always was), one role on that role's own
// page, where the pipeline in question is that role's.
const SUMMARY = `
  SELECT
    count(*)::int                                              AS total,
    count(*) FILTER (WHERE a.status = 'pending')::int          AS pending,
    count(*) FILTER (WHERE a.status = 'accepted')::int         AS accepted,
    count(*) FILTER (WHERE a.status = 'declined')::int         AS declined,
    count(*) FILTER (WHERE a.ai_use_level <> 'clean')::int     AS ai_flagged,
    count(*) FILTER (WHERE i.status = 'booked')::int           AS booked,
    count(*) FILTER (WHERE i.status = 'no_show')::int          AS no_shows
  FROM recruit_applicants a
  LEFT JOIN LATERAL (
    SELECT status FROM recruit_interviews
     WHERE applicant_id = a.id ORDER BY created_at DESC LIMIT 1
  ) i ON true
  WHERE ($1::recruit_role IS NULL OR a.role = $1)
`;

/**
 * Final re-book links that are out and not yet used -- the "Re-books pending"
 * figure, and the banner for the ones about to run out.
 *
 * Whole pipeline, like SUMMARY, not the filtered page. Only an accepted
 * applicant whose LATEST interview is the unbooked final chance counts: once
 * they book, or the link expires and the sweep closes the application, it is
 * no longer pending. Through to_jsonb, like every new read. $1 is the page's
 * scope, as for SUMMARY.
 */
const REBOOKS = `
  SELECT a.id, a.full_name, a.email, i.token_expires_at
    FROM recruit_applicants a
    JOIN LATERAL (
      SELECT li.status, li.token_expires_at,
             COALESCE((to_jsonb(li) ->> 'is_final_chance')::boolean, false) AS is_final_chance
        FROM recruit_interviews li
       WHERE li.applicant_id = a.id ORDER BY li.created_at DESC LIMIT 1
    ) i ON true
   WHERE ($1::recruit_role IS NULL OR a.role = $1)
     AND a.status = 'accepted'
     AND i.status = 'invited'
     AND i.is_final_chance
     AND i.token_expires_at > now()
   ORDER BY i.token_expires_at
`;

export function createAdminRouter() {
  const router = Router();

  // Sign-in is rate limited far harder than the read endpoints: it is the one
  // place a password can be guessed at.
  const loginLimiter = rateLimit({
    windowMs: Number(process.env.ADMIN_LOGIN_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.ADMIN_LOGIN_MAX || 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many sign-in attempts. Please wait and try again.' },
  });

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  /** Exchange a username and password for a short-lived token. */
  router.post('/session', loginLimiter, async (req, res) => {
    if (!process.env.ADMIN_TOKEN_SECRET) {
      return res.status(503).json({ ok: false, error: 'Admin access is not configured.' });
    }

    try {
      const admin = await authenticate(req.body?.username, req.body?.password);
      if (!admin) {
        // One message for both wrong-username and wrong-password: telling them
        // apart is a free hint about which half to keep guessing.
        console.warn(`[fac-recruit] failed admin sign-in for "${req.body?.username ?? ''}"`);
        return res.status(401).json({ ok: false, error: 'Those details were not recognised.' });
      }

      return res.json({
        ok: true,
        token: issueToken(admin),
        email: admin.email,
        role: admin.role,
      });
    } catch (error) {
      console.error('[fac-recruit] sign-in failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not check those details.' });
    }
  });

  // Everything past here needs a valid token.
  router.use(requireAdmin());

  router.get('/me', (req, res) => res.json({ ok: true, admin: req.admin }));

  /**
   * Changing your own password.
   *
   * Not an administrator's job — everyone should be able to change their own,
   * and until now nobody could change theirs at all. The current one is asked
   * for because a borrowed, still-signed-in browser should not be enough to
   * lock the real owner out.
   */
  router.put('/me/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};

    if (typeof newPassword !== 'string' || newPassword.length < 12) {
      return res.status(400).json({
        ok: false,
        error: 'Use at least 12 characters. This guards real candidates\' personal data.',
      });
    }
    if (req.admin.source !== 'database') {
      return res.status(409).json({
        ok: false,
        error: 'This sign-in comes from the server configuration. Create a proper account first.',
      });
    }

    try {
      const proven = await authenticate(req.admin.username, currentPassword);
      if (!proven) {
        return res.status(401).json({ ok: false, error: 'That current password is not right.' });
      }

      await pool.query(
        'UPDATE recruit_admins SET password_hash = $2, updated_at = now() WHERE id = $1',
        [req.admin.id, hashPassword(newPassword)],
      );
      console.log(`[fac-recruit] ${req.admin.email} changed their own password`);
      return res.json({ ok: true });
    } catch (error) {
      console.error('[fac-recruit] password change failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not change your password.' });
    }
  });

  /* ── The team. Administrators only. ─────────────────────────────────────
   *
   * Spec §8.1 asks for a permission around the recruitment feature. This is
   * the half of it that decides who gets one at all — and it is separated
   * from reviewing candidates on purpose: someone hired to screen CVs should
   * not also be able to hand out logins.
   */
  const admins = Router();
  admins.use(requireRole('administrator'));

  admins.get('/', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, username, email, full_name, role, active, created_by_email,
                created_at, last_seen_at
           FROM recruit_admins
          ORDER BY active DESC, username`,
      );
      return res.json({ ok: true, admins: rows, bootstrap: await usingBootstrap() });
    } catch (error) {
      console.error('[fac-recruit] team list failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not load the team.' });
    }
  });

  admins.post('/', async (req, res) => {
    const { username, email, fullName, password, role } = req.body ?? {};

    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username ?? '')) {
      return res.status(400).json({
        ok: false,
        error: 'A username is 2 to 40 letters, numbers, dots, dashes or underscores.',
      });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '')) {
      return res.status(400).json({ ok: false, error: 'That does not look like an email address.' });
    }
    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({
        ok: false,
        error: 'Use at least 12 characters. This guards real candidates\' personal data.',
      });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ ok: false, error: 'Pick a reviewer or an administrator.' });
    }

    try {
      /*
       * The first account has to be an administrator.
       *
       * Creating a reviewer first closes the bootstrap — an account exists, so
       * ADMIN_USERS stops being accepted — while leaving nobody who can reach
       * this screen. The portal ends up with no way to administer it short of
       * editing the database by hand. The last-administrator guard below does
       * not catch this, because there was never an administrator to be the
       * last one.
       */
      if (await usingBootstrap()) {
        if (role !== 'administrator') {
          return res.status(400).json({
            ok: false,
            error:
              'The first account has to be an administrator, so somebody can add everybody else. ' +
              'You can add reviewers straight after.',
          });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO recruit_admins (username, email, full_name, password_hash, role, created_by_email)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, email, full_name, role, active, created_at`,
        [username, email, fullName?.trim() || null, hashPassword(password), role, req.admin.email],
      );

      console.log(`[fac-recruit] ${req.admin.email} added ${username} as ${role}`);
      return res.status(201).json({ ok: true, admin: rows[0] });
    } catch (error) {
      // 23505 = unique_violation, which here is the username or the email.
      if (error.code === '23505') {
        return res.status(409).json({
          ok: false,
          error: 'Somebody already has that username or email address.',
        });
      }
      console.error('[fac-recruit] adding a colleague failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not add them.' });
    }
  });

  /** Change a role, deactivate, reactivate, or set a new password for someone. */
  admins.patch('/:id', async (req, res) => {
    const { role, active, password } = req.body ?? {};
    const id = Number(req.params.id);

    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ ok: false, error: 'Pick a reviewer or an administrator.' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 12)) {
      return res.status(400).json({ ok: false, error: 'Use at least 12 characters.' });
    }

    /*
     * The two ways to lock everybody out, refused.
     *
     * Removing your own access, or demoting yourself, are both things that
     * would leave the portal with one fewer administrator — and if you are the
     * last one, with none at all and no way back in except editing the server.
     * Someone else can do either of these to you; you cannot do them to
     * yourself.
     */
    if (id === req.admin.id && (active === false || role === 'reviewer')) {
      return res.status(409).json({
        ok: false,
        error: 'You cannot remove your own administrator access. Ask a colleague to do it.',
      });
    }

    try {
      if (role === 'reviewer' || active === false) {
        const { rows: others } = await pool.query(
          `SELECT count(*)::int AS n FROM recruit_admins
            WHERE role = 'administrator' AND active AND id <> $1`,
          [id],
        );
        if (others[0].n === 0) {
          return res.status(409).json({
            ok: false,
            error: 'That is the last administrator. Make somebody else one first.',
          });
        }
      }

      const { rows } = await pool.query(
        `UPDATE recruit_admins
            SET role          = COALESCE($2, role),
                active        = COALESCE($3, active),
                password_hash = COALESCE($4, password_hash),
                updated_at    = now()
          WHERE id = $1
          RETURNING id, username, email, full_name, role, active`,
        [id, role ?? null, active ?? null, password ? hashPassword(password) : null],
      );
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'No such person.' });

      console.log(
        `[fac-recruit] ${req.admin.email} updated ${rows[0].username}` +
          `${role ? ` role=${role}` : ''}${active !== undefined ? ` active=${active}` : ''}` +
          `${password ? ' (new password)' : ''}`,
      );
      return res.json({ ok: true, admin: rows[0] });
    } catch (error) {
      console.error('[fac-recruit] updating a colleague failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not save that.' });
    }
  });

  router.use('/team', admins);

  /**
   * Every email the portal can send, rendered from invented sample data.
   *
   * A manager should be able to read what a candidate will receive BEFORE
   * anybody receives it — a rejection letter is not something to discover the
   * wording of afterwards. Nothing here touches a real record: the samples are
   * fixed, so this page cannot leak an applicant.
   *
   * `mailMode` is on the response because the templates are only half the
   * question. The other half is whether any of it is actually being sent.
   */
  router.get('/templates', (_req, res) =>
    res.json({ ok: true, mode: mailMode(), templates: describeTemplates() }),
  );

  /**
   * Everything on the settings screen: who interviews, the rules that decide
   * which slots exist, the periods they are unavailable, and the flags.
   *
   * Spec §8.3. Until now these rules could only be changed by running SQL
   * against production, which is not a thing anyone should have to do to move
   * lunch by half an hour.
   */
  router.get('/settings', async (req, res) => {
    try {
      const { rows: interviewers } = await pool.query(
        `SELECT i.id, i.full_name, i.email, i.personal_timezone, i.active,
                r.timezone, r.weekdays, r.day_start, r.day_end, r.slot_minutes,
                r.buffer_minutes, r.min_notice_hours, r.max_days_ahead, r.blocks
           FROM recruit_interviewers i
           -- The default rule only: since recruit_018 an interviewer can also
           -- have a rule per role, and joining those would return the same
           -- interviewer several times over.
           LEFT JOIN recruit_availability_rules r
                  ON r.interviewer_id = i.id AND to_jsonb(r) ->> 'role' IS NULL
          WHERE i.active
          ORDER BY i.id`,
      );
      if (!interviewers[0]) {
        return res.status(503).json({ ok: false, error: 'No interviewer is configured.' });
      }

      // What is about to be deleted, so the policy is visible rather than
      // something that quietly happens overnight.
      const { months, due } = await dueForDeletion();

      return res.json({
        ok: true,
        you: req.admin,
        interviewer: interviewers[0],
        blackouts: await listBlackouts(interviewers[0].id),
        flags: await allFlags(),
        mailMode: mailMode(),
        // Whether the public form is actually protected. A widget on the page
        // is not the control; the server verifying the token is, and only this
        // knows whether it does.
        captchaMode: captchaMode(),
        // Same reason as captchaMode: the switch on the page is not the
        // control. Without a model key nothing reads the written answers, so
        // an empty "AI used" column means the check is not running rather
        // than that nobody is cheating -- and those look identical.
        aiReviewMode: llmMode(),
        // Same reason again: nothing on screen distinguishes "no interview was
        // posted to the channel" from "posting was never switched on".
        chatMode: chatMode(),
        chatMissing: chatMissing(),
        retention: { months, dueCount: due.length },
      });
    } catch (error) {
      console.error('[fac-recruit] settings load failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not load the settings.' });
    }
  });

  /**
   * The address the interviewer is told about bookings at.
   *
   * Its own route rather than part of the availability form: it is the one
   * field here that decides whether a person hears about an interview at all,
   * and it should not be saveable as a side effect of moving working hours.
   */
  router.put('/settings/interviewer', requireRole('administrator'), async (req, res) => {
    const email = String(req.body?.email ?? '').trim();

    if (!email) return res.status(400).json({ ok: false, error: 'Enter an email address.' });
    if (email.length > FIELD_LIMITS.email) {
      return res.status(400).json({ ok: false, error: 'That email address is too long.' });
    }
    if (!EMAIL.test(email)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE recruit_interviewers SET email = $1
          WHERE id = (SELECT id FROM recruit_interviewers WHERE active ORDER BY id LIMIT 1)
      RETURNING id, full_name, email`,
        [email],
      );
      if (!rows[0]) {
        return res.status(503).json({ ok: false, error: 'No interviewer is configured.' });
      }
      return res.json({ ok: true, interviewer: rows[0] });
    } catch (error) {
      console.error('[fac-recruit] interviewer email save failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not save that address.' });
    }
  });

  /** Changes the availability rules. */
  router.put('/settings/availability', requireRole('administrator'), async (req, res) => {
    const { interviewerId, dayStart, dayEnd, weekdays, slotMinutes, minNoticeHours, maxDaysAhead, blocks } =
      req.body ?? {};

    // Checked here rather than trusted to the form: these values decide what a
    // candidate is offered, and a day that ends before it starts would empty
    // the calendar with no error anywhere.
    const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!clock.test(dayStart ?? '') || !clock.test(dayEnd ?? '')) {
      return res.status(400).json({ ok: false, error: 'Times must look like 09:00.' });
    }
    if (dayEnd <= dayStart) {
      return res.status(400).json({ ok: false, error: 'The day must end after it starts.' });
    }
    if (!Array.isArray(weekdays) || weekdays.length === 0) {
      return res.status(400).json({ ok: false, error: 'Pick at least one working day.' });
    }
    if (![15, 20, 30, 45, 60].includes(Number(slotMinutes))) {
      return res.status(400).json({ ok: false, error: 'That interview length is not one of the options.' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE recruit_availability_rules
            SET day_start = $2, day_end = $3, weekdays = $4, slot_minutes = $5,
                min_notice_hours = $6, max_days_ahead = $7, blocks = $8::jsonb
          -- The default rule only. A role with hours of its own (recruit_018)
          -- keeps them: this screen sets the hours every other role follows,
          -- and must not quietly overwrite the India ones.
          WHERE interviewer_id = $1 AND to_jsonb(recruit_availability_rules) ->> 'role' IS NULL
          RETURNING *`,
        [
          interviewerId,
          dayStart,
          dayEnd,
          // ISO weekdays: Monday 1 through Sunday 7. Zero is not a day.
          weekdays.map(Number).filter((d) => d >= 1 && d <= 7),
          Number(slotMinutes),
          Math.max(0, Number(minNoticeHours) || 0),
          Math.min(90, Math.max(1, Number(maxDaysAhead) || 14)),
          JSON.stringify(Array.isArray(blocks) ? blocks : []),
        ],
      );
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'No rules for that interviewer.' });

      console.log(`[fac-recruit] ${req.admin.email} changed the availability rules`);
      return res.json({ ok: true, rule: rows[0] });
    } catch (error) {
      console.error('[fac-recruit] availability update failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not save those rules.' });
    }
  });

  /** Marks a period unavailable. */
  router.post('/settings/blackouts', requireRole('administrator'), async (req, res) => {
    try {
      const { blackout, clashes } = await addBlackout({
        interviewerId: req.body?.interviewerId,
        startsAt: req.body?.startsAt,
        endsAt: req.body?.endsAt,
        reason: req.body?.reason,
        createdByEmail: req.admin.email,
      });
      // Booked interviews inside the period are reported, never cancelled.
      // Marking yourself away is not the same as calling off three interviews.
      return res.status(201).json({ ok: true, blackout, clashes });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ ok: false, error: error.message });
      console.error('[fac-recruit] blackout failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not save that.' });
    }
  });

  router.delete('/settings/blackouts/:id', requireRole('administrator'), async (req, res) => {
    try {
      const removed = await removeBlackout(req.params.id, Number(req.query.interviewerId));
      if (!removed) return res.status(404).json({ ok: false, error: 'No such entry.' });
      return res.json({ ok: true });
    } catch (error) {
      console.error('[fac-recruit] blackout delete failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not remove that.' });
    }
  });

  /**
   * The manager's calendar for a date range.
   *
   * A view, not a decision: everything it reports was already decided by the
   * availability rules, the bookings and the blocked periods. Blocking time
   * from it goes through the same endpoint the settings screen uses.
   */
  router.get('/calendar', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id FROM recruit_interviewers WHERE active ORDER BY id LIMIT 1',
      );
      if (!rows[0]) return res.status(503).json({ ok: false, error: 'No interviewer is configured.' });

      const calendar = await buildCalendar({
        interviewerId: rows[0].id,
        from: req.query.from,
        to: req.query.to,
      });
      if (!calendar) {
        return res.status(503).json({ ok: false, error: 'No availability is configured.' });
      }

      return res.json({
        ok: true,
        interviewerId: rows[0].id,
        // The popup offers "Mark attended" / "Not attended" only when it is on.
        noShowRebook: await isEnabled('recruitment_noshow_rebook'),
        ...calendar,
      });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ ok: false, error: error.message });
      console.error('[fac-recruit] calendar failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not load the calendar.' });
    }
  });

  /**
   * Changes how long a declined applicant's CV is kept. Spec §12.
   *
   * Zero switches deletion off, which is a legitimate thing to want while
   * someone works out what the period should be — and far better than the
   * alternative of a wrong number quietly deleting things.
   */
  router.put('/settings/retention', requireRole('administrator'), async (req, res) => {
    const months = Number(req.body?.months);
    if (!Number.isFinite(months) || months < 0 || months > 120) {
      return res.status(400).json({ ok: false, error: 'That has to be a number of months, 0 to 120.' });
    }

    try {
      const saved = await setRetentionMonths(months);
      const { due } = await dueForDeletion();
      console.log(
        `[fac-recruit] ${req.admin.email} set CV retention to ${saved} month(s); ${due.length} due`,
      );
      return res.json({ ok: true, months: saved, dueCount: due.length });
    } catch (error) {
      console.error('[fac-recruit] retention update failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not save that.' });
    }
  });

  /** Flips a feature flag. Spec §2. */
  router.put('/settings/flags/:name', requireRole('administrator'), async (req, res) => {
    if (!FLAGS.includes(req.params.name)) {
      return res.status(404).json({ ok: false, error: 'No such setting.' });
    }
    try {
      const enabled = await setFlag(req.params.name, req.body?.enabled === true);
      console.log(
        `[fac-recruit] ${req.admin.email} turned ${req.params.name} ${enabled ? 'ON' : 'OFF'}`,
      );
      return res.json({ ok: true, name: req.params.name, enabled });
    } catch (error) {
      console.error('[fac-recruit] flag update failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not change that.' });
    }
  });

  // Teams and Meet links are long, but not arbitrarily so.
  const MEETING_LINK_MAX = 1000;

  router.get('/applications', async (req, res) => {
    const status = STATUSES.has(req.query.status) ? req.query.status : null;
    const ROLE_KEYS = ['india_intern', 'sa_paralegal', 'sa_sales', 'india_aidev'];
    const role = ROLE_KEYS.includes(req.query.role) ? req.query.role : null;
    // The page's scope, separate from the role filter: a role's own page sends
    // it so the tiles and re-book figures are that role's. /admin never sends
    // it, and its tiles stay the whole pipeline whichever role button is on.
    const scope = ROLE_KEYS.includes(req.query.scope) ? req.query.scope : null;
    const search =
      typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

    // Dates arrive as yyyy-mm-dd from a native date input. Anything else is
    // ignored rather than argued with: a half-typed date should narrow
    // nothing, not empty the screen.
    const asDate = (value) =>
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    const from = asDate(req.query.from);
    const to = asDate(req.query.to);

    // An allow-list, not a passthrough. The sort reaches SQL as a bound
    // parameter either way, but naming the permitted values here means an
    // unexpected one falls back to newest-first rather than becoming an
    // argument with the database.
    const sort = SORTS.has(req.query.sort) ? req.query.sort : null;

    // 'all' and absent mean the same thing: do not narrow. Anything
    // unrecognised is ignored rather than returning nothing, so a stale
    // bookmark shows the list instead of an empty screen.
    const aiLevel = AI_LEVELS.has(req.query.ai) ? req.query.ai : null;
    const interviewStatus = INTERVIEW_FILTERS.has(req.query.interview) ? req.query.interview : null;

    try {
      const noShowRebook = await isEnabled('recruitment_noshow_rebook');
      const [list, count, summary, tabs, rebooks] = await Promise.all([
        pool.query(LIST, [status, role, search, PAGE_SIZE, (page - 1) * PAGE_SIZE, from, to, aiLevel, sort, interviewStatus]),
        pool.query(COUNT, [status, role, search, from, to, aiLevel, interviewStatus]),
        pool.query(SUMMARY, [scope]),
        pool.query(TAB_COUNTS, [role, search, from, to, aiLevel, interviewStatus]),
        // Not asked at all while the feature is off: there is nothing to show.
        noShowRebook ? pool.query(REBOOKS, [scope]) : Promise.resolve({ rows: [] }),
      ]);
      const warnBefore = Date.now() + REBOOK_WARN_HOURS * 3_600_000;

      return res.json({
        ok: true,
        applications: list.rows,
        page,
        pageSize: PAGE_SIZE,
        total: count.rows[0].total,
        summary: summary.rows[0],
        // Beside the status filters. Separate from `summary`, which stays the
        // whole pipeline (or the page's role) however the screen is filtered.
        tabs: tabs.rows[0],
        // Whether the no-show re-book is switched on. The dashboard shows its
        // button, chips, tile and banner only when it is -- off, the screen is
        // exactly as it was.
        noShowRebook,
        rebooks: noShowRebook
          ? {
              pending: rebooks.rows.length,
              expiringSoon: rebooks.rows
                .filter((r) => new Date(r.token_expires_at).getTime() <= warnBefore)
                .map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, expiresAt: r.token_expires_at })),
            }
          : null,
        // Whether a decision actually reaches the candidate. The confirmation
        // dialog says so in as many words, and it must not claim an email that
        // is only being written to a file — or none at all.
        emailLive: (await isEnabled('recruitment_alerts')) && mailMode() === 'smtp',
      });
    } catch (error) {
      console.error('[fac-recruit] admin list failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not load applications.' });
    }
  });

  /** The full record, including the written answers. */
  router.get('/applications/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.*, i.status AS interview_status, i.starts_at AS interview_at,
                i.meet_link AS meet_link
           FROM recruit_applicants a
           LEFT JOIN LATERAL (
             SELECT status, starts_at, meet_link FROM recruit_interviews
              WHERE applicant_id = a.id ORDER BY created_at DESC LIMIT 1
           ) i ON true
          WHERE a.id = $1`,
        [req.params.id],
      );
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'No such application.' });

      const { rows: audit } = await pool.query(
        `SELECT action, actor_email, payload, created_at FROM recruit_audit
          WHERE applicant_id = $1 ORDER BY created_at`,
        [req.params.id],
      );

      // What has actually been sent to this person, so a manager can answer
      // "did they get the link?" without guessing.
      const emails = await historyFor(req.params.id);

      // The model's review, if there is one. `raw` is deliberately left behind:
      // it is kept for a dispute, not for a screen, and it is large.
      const { rows: review } = await pool.query(
        `SELECT status, model, prompt_version, fitment_score, fitment_summary,
                fitment_reasons, ai_opinion, ai_rationale, cv_chars, last_error,
                completed_at
           FROM recruit_llm_reviews WHERE applicant_id = $1`,
        [req.params.id],
      );

      return res.json({
        ok: true,
        application: rows[0],
        audit,
        emails,
        mailMode: mailMode(),
        review: review[0] ?? null,
        // Shown beside the model's number so a manager can see the two
        // disagree, which is the only reason to keep both.
        ruleScore: rows[0].rule_score,
        // The questions this applicant was actually asked, so the dashboard
        // can label their answers without holding its own copy per role.
        // Weights stripped, as on the public form.
        writtenQuestions: writtenQuestionsFor(rows[0].role),
        assessment: publicQuestionsFor(rows[0].role),
      });
    } catch (error) {
      console.error('[fac-recruit] admin detail failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not load that application.' });
    }
  });

  /**
   * Accept or decline.
   *
   * Accepting mints the booking token here, so the decision and the candidate's
   * booking link are created in one transaction — an accepted applicant can
   * never end up without a way to book.
   */
  router.patch('/applications/:id', async (req, res) => {
    const { status } = req.body ?? {};
    if (status !== 'accepted' && status !== 'declined') {
      return res.status(400).json({ ok: false, error: 'Status must be accepted or declined.' });
    }

    /**
     * Why, when declining. Only ever recorded on a decline — an accepted
     * application has no reason to carry one, and storing it would leave a
     * field that means nothing half the time.
     *
     * An unrecognised code is refused rather than quietly stored: a code the
     * dropdown no longer offers is a record nobody can read back.
     */
    let reasonCode = null;
    let reasonNote = null;
    if (status === 'declined') {
      const asked = typeof req.body?.reason === 'string' ? req.body.reason : NO_REASON;
      if (!isDeclineReason(asked)) {
        return res.status(400).json({ ok: false, error: 'That is not a reason we recognise.' });
      }
      reasonCode = asked === NO_REASON ? null : asked;
      if (reasonCode === 'other') {
        reasonNote = String(req.body?.reasonNote ?? '').trim().slice(0, 500) || null;
        if (!reasonNote) {
          return res.status(400).json({ ok: false, error: 'Please write the reason, or choose No reason.' });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE recruit_applicants
            SET status = $2, decided_by_email = $3, decided_at = now(),
                decline_reason = $4, decline_reason_note = $5
          WHERE id = $1 AND status = 'pending'
          RETURNING id, full_name, email, role, decline_reason, decline_reason_note`,
        [req.params.id, status, req.admin.email, reasonCode, reasonNote],
      );

      if (!rows[0]) {
        await client.query('ROLLBACK');
        // Either it does not exist or someone else already decided it. Both
        // mean "your view is stale", which is what the message should say.
        return res.status(409).json({
          ok: false,
          error: 'That application has already been decided, or no longer exists.',
        });
      }

      let bookingToken = null;
      if (status === 'accepted') {
        const { rows: interviewer } = await client.query(
          'SELECT id FROM recruit_interviewers WHERE active ORDER BY id LIMIT 1',
        );
        if (!interviewer[0]) throw new Error('no active interviewer configured');

        const { token, hash } = generateBookingToken();
        await client.query(
          `INSERT INTO recruit_interviews (applicant_id, interviewer_id, booking_token_hash, token_expires_at, status)
           VALUES ($1, $2, $3, $4, 'invited')`,
          [rows[0].id, interviewer[0].id, hash, tokenExpiry()],
        );
        // Returned once, to be put in the email. Never stored, never
        // retrievable again.
        bookingToken = token;
      }

      await client.query(
        `INSERT INTO recruit_audit (applicant_id, actor_email, action, payload)
         VALUES ($1, $2, $3, $4)`,
        [
          rows[0].id,
          req.admin.email,
          status,
          // The reason goes in the trail as well as on the row. The row holds
          // the current state; the trail holds what was decided and why at the
          // moment it was decided, which is the question anyone asks later.
          JSON.stringify({ decidedBy: req.admin.email, reason: reasonCode, note: reasonNote }),
        ],
      );

      // Queued in the same transaction as the decision. Either both happen or
      // neither does — nobody is accepted without their invitation queued, and
      // no invitation goes out for a decision that rolled back.
      await notifyDecision(client, { applicant: rows[0], status, bookingToken });

      await client.query('COMMIT');
      // The token is still returned, so a manager can send it by hand if they
      // would rather not wait — or if no mailbox is configured yet.
      return res.json({ ok: true, status, bookingToken });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[fac-recruit] decision failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not record that decision.' });
    } finally {
      client.release();
    }
  });

  /**
   * Reissues a booking link.
   *
   * The token is returned exactly once, at the moment of acceptance, and
   * stored only as a hash — so a manager who closes that dialog without
   * copying it, or emails it to a typo, has stranded the candidate with no
   * way back. There has to be a second chance, and this is it.
   *
   * Reissuing invalidates the previous link by replacing the hash. That is
   * the point: if the reason for reissuing is that the first one went to the
   * wrong address, the wrong address must stop working.
   */
  router.post('/applications/:id/booking-link', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: applicant } = await client.query(
        'SELECT id, status, full_name, email, role FROM recruit_applicants WHERE id = $1',
        [req.params.id],
      );
      if (!applicant[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'No such application.' });
      }
      if (applicant[0].status !== 'accepted') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          ok: false,
          error: 'Only an accepted applicant has a booking link. Accept them first.',
        });
      }

      const { rows: existing } = await client.query(
        `SELECT i.id, i.status,
                COALESCE((to_jsonb(i) ->> 'is_final_chance')::boolean, false) AS is_final_chance
           FROM recruit_interviews i
          WHERE i.applicant_id = $1 ORDER BY i.created_at DESC LIMIT 1`,
        [req.params.id],
      );
      const latest = existing[0];

      if (latest?.status === 'attended') {
        await client.query('ROLLBACK');
        // They came. A link to book the interview they have already had would
        // only confuse; whatever happens next is a new decision, not a link.
        return res.status(409).json({
          ok: false,
          error: 'That interview has already taken place.',
        });
      }

      // While the no-show re-book is switched on, a final chance cannot be
      // reissued or extended, and a missed interview is re-offered only through
      // "Not attended". Off-switch: everything below runs exactly as before.
      const linkGuard = reissueGuard({
        flagOn: await isEnabled('recruitment_noshow_rebook'),
        latest,
      });
      if (linkGuard) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, code: linkGuard.code, error: linkGuard.message });
      }

      // A no-show is the one case where a fresh link IS the point — the spec
      // allows a single rebook, and this is how it is offered.
      const rebookingAfterNoShow = latest?.status === 'no_show';

      const { token, hash } = generateBookingToken();

      // A cancelled interview keeps its row — "they cancelled, and when" is
      // worth being able to answer. So a reissue after a cancellation starts
      // a new one rather than reviving the old.
      if (!latest || latest.status === 'cancelled' || rebookingAfterNoShow) {
        const { rows: interviewer } = await client.query(
          'SELECT id FROM recruit_interviewers WHERE active ORDER BY id LIMIT 1',
        );
        if (!interviewer[0]) throw new Error('no active interviewer configured');

        await client.query(
          `INSERT INTO recruit_interviews (applicant_id, interviewer_id, booking_token_hash, token_expires_at, status)
           VALUES ($1, $2, $3, $4, 'invited')`,
          [req.params.id, interviewer[0].id, hash, tokenExpiry()],
        );
      } else {
        // Invited or already booked: rotate the token and extend the clock,
        // leaving any chosen slot alone. A candidate who has booked keeps
        // their time and gets a working link to manage it.
        await client.query(
          `UPDATE recruit_interviews
              SET booking_token_hash = $2, token_expires_at = $3, updated_at = now()
            WHERE id = $1`,
          [latest.id, hash, tokenExpiry()],
        );
      }

      await client.query(
        `INSERT INTO recruit_audit (applicant_id, actor_email, action, payload)
         VALUES ($1, $2, 'link_reissued', $3)`,
        [
          req.params.id,
          req.admin.email,
          JSON.stringify({ reissuedBy: req.admin.email, rebookingAfterNoShow }),
        ],
      );

      const { rows: freshInterview } = await client.query(
        'SELECT id FROM recruit_interviews WHERE applicant_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.id],
      );

      // After a no-show the candidate needs the "we missed you" email, not a
      // second copy of the one congratulating them on being shortlisted.
      if (rebookingAfterNoShow) {
        await notifyNoShow(client, {
          applicant: applicant[0],
          interviewId: freshInterview[0]?.id ?? null,
          bookingToken: token,
        });
      } else {
        await notifyDecision(client, {
          applicant: applicant[0],
          status: 'accepted',
          bookingToken: token,
        });
      }

      await client.query('COMMIT');
      console.log(`[fac-recruit] ${req.admin.email} reissued a booking link for ${req.params.id}`);

      return res.json({ ok: true, bookingToken: token, email: applicant[0].email, fullName: applicant[0].full_name });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[fac-recruit] link reissue failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not reissue that link.' });
    } finally {
      client.release();
    }
  });

  /**
   * Records what actually happened at the interview.
   *
   * Without this the no-show figure is decorative — the column exists, the
   * dashboard has a tile for it, and nothing could ever set it. It is also
   * the only signal that distinguishes a candidate who did not turn up from
   * one who is still waiting for their interview.
   */
  /**
   * Sends the candidate their video link.
   *
   * A stand-in for the calendar integration, and deliberately not a throwaway
   * one: the link is SAVED on the interview as well as emailed. That is what
   * makes it worth more than a copy-and-paste into Outlook -- every template
   * resolves its merge fields when it sends, so from this moment both
   * reminders carry the link too, and so does the booking page.
   */
  router.post('/applications/:id/meeting-link', async (req, res) => {
    const link = String(req.body?.link ?? '').trim();

    if (!link) return res.status(400).json({ ok: false, error: 'Paste the meeting link first.' });
    if (link.length > MEETING_LINK_MAX) {
      return res.status(400).json({ ok: false, error: 'That link is too long to be a meeting link.' });
    }

    // Parsed rather than pattern-matched: this ends up in an email as
    // something a candidate is told to click, so it has to be a real URL.
    let parsed;
    try {
      parsed = new URL(link);
    } catch {
      return res.status(400).json({ ok: false, error: 'That does not look like a link. It should start with https://' });
    }
    // https only. A plain-http link in an email is a downgrade we would be
    // asking somebody to accept on our word.
    if (parsed.protocol !== 'https:') {
      return res.status(400).json({ ok: false, error: 'The link must start with https://' });
    }

    try {
      const { rows } = await pool.query(
        `SELECT id, status, starts_at FROM recruit_interviews
          WHERE applicant_id = $1 AND starts_at IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [req.params.id],
      );
      const interview = rows[0];

      if (!interview) {
        return res.status(409).json({ ok: false, error: 'That candidate has not booked an interview yet.' });
      }
      if (interview.status === 'cancelled') {
        return res.status(409).json({ ok: false, error: 'That interview was cancelled.' });
      }

      const { rows: who } = await pool.query(
        'SELECT id, full_name, email FROM recruit_applicants WHERE id = $1',
        [req.params.id],
      );
      if (!who[0]) return res.status(404).json({ ok: false, error: 'No such applicant.' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE recruit_interviews SET meet_link = $2, updated_at = now() WHERE id = $1',
          [interview.id, link],
        );
        await client.query(
          `INSERT INTO recruit_audit (applicant_id, actor_email, action, payload)
           VALUES ($1, $2, $3, $4)`,
          [req.params.id, req.admin.email, 'meeting_link_sent', JSON.stringify({ link })],
        );
        // Queued in the same transaction as the saved link, so the email can
        // never promise a link the interview does not have.
        await notifyMeetingLink(client, { applicant: who[0], interviewId: interview.id });
        await client.query('COMMIT');
      } catch (failure) {
        await client.query('ROLLBACK').catch(() => {});
        throw failure;
      } finally {
        client.release();
      }

      return res.json({
        ok: true,
        link,
        // Said plainly rather than assumed by the screen: in file mode this
        // email is written to disk and the candidate is told nothing.
        delivered: (await isEnabled('recruitment_alerts')) && mailMode() === 'smtp',
      });
    } catch (error) {
      console.error('[fac-recruit] meeting link send failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not send that link.' });
    }
  });

  router.patch('/applications/:id/interview', async (req, res) => {
    const { status } = req.body ?? {};
    if (status !== 'attended' && status !== 'no_show') {
      return res.status(400).json({ ok: false, error: 'Status must be attended or no_show.' });
    }

    try {
      // The most recent interview that actually HAS a time, not simply the
      // most recent row. Offering a rebook creates a new, unbooked interview,
      // and a mis-clicked no-show still has to be correctable afterwards.
      //
      // is_final_chance is read through to_jsonb, not by name: this button is
      // used every day, and naming a column recruit_015 adds would break it
      // outright if the code ever reached production before that migration.
      const { rows } = await pool.query(
        `SELECT i.id, i.status, i.starts_at,
                COALESCE((to_jsonb(i) ->> 'is_final_chance')::boolean, false) AS is_final_chance
           FROM recruit_interviews i
          WHERE i.applicant_id = $1 AND i.starts_at IS NOT NULL
          ORDER BY i.created_at DESC LIMIT 1`,
        [req.params.id],
      );
      const interview = rows[0];

      if (!interview || !interview.starts_at) {
        return res.status(409).json({ ok: false, error: 'That candidate has not booked an interview.' });
      }
      if (interview.status === 'cancelled') {
        return res.status(409).json({ ok: false, error: 'That interview was cancelled.' });
      }
      // Marking an interview that has not started yet is not a record of
      // anything — it is a guess, and one that would quietly become wrong.
      if (new Date(interview.starts_at) > new Date()) {
        return res.status(409).json({ ok: false, error: 'That interview has not happened yet.' });
      }

      // A missed FINAL chance must go through "Not attended — final", the only
      // path that also closes the application. Off-switch: unchanged behaviour.
      const finalGuard = attendanceGuard({
        flagOn: await isEnabled('recruitment_noshow_rebook'),
        interview,
        status,
      });
      if (finalGuard) {
        return res.status(409).json({ ok: false, code: finalGuard.code, error: finalGuard.message });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE recruit_interviews SET status = $2, updated_at = now() WHERE id = $1',
          [interview.id, status],
        );
        await client.query(
          `INSERT INTO recruit_audit (applicant_id, actor_email, action, payload)
           VALUES ($1, $2, $3, $4)`,
          [req.params.id, req.admin.email, status, JSON.stringify({ markedBy: req.admin.email })],
        );

        // Correcting a mis-clicked no-show must call off the "we missed you"
        // email too, or an apology reaches someone who was there all along.
        if (status === 'attended') {
          await cancelPendingFor(client, interview.id, 'they attended after all');

          /*
           * ...and a final re-book offered for it must go too (plan section 8c).
           * Cancelling the queued email above is not enough: the re-book
           * interview and its 7-day link would stay live, so the candidate
           * could book a "final" interview they never needed -- or, if the
           * email had already gone, be left holding a working link while
           * recorded as having attended. Only an UNBOOKED re-book: once they
           * have booked it, that booking is the interview this button marks.
           *
           * Matched through to_jsonb so this, on a button used every day,
           * cannot break on a database without recruit_015. With no re-book
           * rows (the switch never used) it changes nothing.
           */
          const { rows: withdrawn } = await client.query(
            `UPDATE recruit_interviews r
                SET status = 'cancelled', updated_at = now()
              WHERE to_jsonb(r) ->> 'rebook_of_interview_id' = $1::text
                AND r.status = 'invited'
            RETURNING r.id`,
            [interview.id],
          );
          for (const rebook of withdrawn) {
            await cancelPendingFor(client, rebook.id, 'they attended after all');
            await client.query(
              `INSERT INTO recruit_audit (applicant_id, actor_email, action, payload)
               VALUES ($1, $2, 'rebook_withdrawn', $3)`,
              [
                req.params.id,
                req.admin.email,
                JSON.stringify({
                  withdrawnBy: req.admin.email,
                  rebookInterviewId: rebook.id,
                  missedInterviewId: interview.id,
                }),
              ],
            );
          }
        }

        await client.query('COMMIT');
      } catch (failure) {
        await client.query('ROLLBACK').catch(() => {});
        throw failure;
      } finally {
        client.release();
      }

      return res.json({ ok: true, status });
    } catch (error) {
      console.error('[fac-recruit] attendance update failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not record that.' });
    }
  });

  /**
   * "Not attended" -- mark a missed interview and offer ONE final re-book, or,
   * if the missed interview was already that final chance, end the application.
   *
   * Beside the attendance endpoint above, not instead of it: that one still
   * records attended or no-show and sends nothing, exactly as before. This one
   * does the whole job in one press.
   *
   * Behind `recruitment_noshow_rebook`. Off, it answers 404 -- as though it did
   * not exist -- so nothing about the dashboard changes until it is switched on
   * deliberately, after the email wording has been approved.
   *
   * The rules and the work live in lib/rebookPolicy.js and lib/notAttended.js;
   * this only translates their result into a response.
   */
  /**
   * What "Not attended" would do for this applicant, without doing it: whether
   * it is allowed, which path, and the exact email -- for the confirm dialog on
   * the dashboard and the calendar. Read-only. 404 while switched off.
   */
  router.get('/applications/:id/not-attended', async (req, res) => {
    if (!(await isEnabled('recruitment_noshow_rebook'))) {
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }
    try {
      const preview = await previewNotAttended({ applicantId: req.params.id });
      if (!preview.ok) {
        return res.status(preview.status).json({ ok: false, code: preview.code, error: preview.message });
      }
      return res.json({
        ...preview,
        // Asked now, not when the list loaded: the dialog must not promise an
        // email that is only going to a file, or hide one that really goes.
        emailLive: (await isEnabled('recruitment_alerts')) && mailMode() === 'smtp',
      });
    } catch (error) {
      console.error('[fac-recruit] not attended preview failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not check that just now.' });
    }
  });

  /**
   * The firm cancels an interview, and offers another time.
   *
   * Not the candidate's own cancellation (booking.js), which says "as
   * requested" and offers nothing: this is us calling it off, so it
   * apologises and carries a NEW booking link. What it does, in one
   * transaction:
   *
   *   the interview  -> cancelled, and its row kept (when and who, later)
   *   its reminders  -> cancelled, so nothing still says "tomorrow"
   *   a new invite   -> a fresh row and token, exactly as a reissued link
   *   the email      -> recruit.cancelled.byus, carrying that token
   *
   * The calendar event is removed afterwards, outside the transaction, the
   * same way booking.js does it: Google being slow must not roll back a
   * cancellation the database has already agreed to.
   */
  router.post('/applications/:id/interview/cancel', async (req, res) => {
    // Two ways to cancel: with a new booking link, or without one. Default
    // true, so a caller that says nothing gets the kinder of the two.
    const rebook = req.body?.rebook !== false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: applicant } = await client.query(
        'SELECT id, email, full_name, role, status FROM recruit_applicants WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      if (!applicant[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'No such applicant.' });
      }

      // The interview to call off: their latest one that is still standing.
      const { rows: latest } = await client.query(
        `SELECT id, status, starts_at, interviewer_id FROM recruit_interviews
          WHERE applicant_id = $1 AND status IN ('invited', 'booked')
          ORDER BY created_at DESC LIMIT 1`,
        [req.params.id],
      );
      if (!latest[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'There is no interview to cancel.' });
      }

      await client.query(
        `UPDATE recruit_interviews SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [latest[0].id],
      );

      // The replacement belongs to the SAME interviewer as the interview we
      // just called off -- with two of them, issuing it against whoever
      // happens to be first would quietly move the candidate to someone
      // else's diary. Their own is the fallback if that one has since gone.
      const { rows: interviewer } = await client.query(
        `SELECT id FROM recruit_interviewers
          WHERE active
          ORDER BY (id = $1) DESC, id LIMIT 1`,
        [latest[0].interviewer_id],
      );
      if (!interviewer[0]) throw new Error('no active interviewer configured');

      // Only when a new time is being offered. Cancelling without one leaves
      // the applicant with no open invitation, which is the point of it.
      let token = null;
      let freshId = null;
      if (rebook) {
        const issued = generateBookingToken();
        token = issued.token;
        const { rows: fresh } = await client.query(
          `INSERT INTO recruit_interviews (applicant_id, interviewer_id, booking_token_hash, token_expires_at, status)
           VALUES ($1, $2, $3, $4, 'invited') RETURNING id`,
          [req.params.id, interviewer[0].id, issued.hash, tokenExpiry()],
        );
        freshId = fresh[0].id;
      }

      await client.query(
        `INSERT INTO recruit_audit (applicant_id, actor_email, action, payload)
         VALUES ($1, $2, 'interview_cancelled_by_us', $3)`,
        [
          req.params.id,
          req.admin.email,
          JSON.stringify({
            cancelledInterviewId: latest[0].id,
            wasStartingAt: latest[0].starts_at,
            rebookOffered: rebook,
            newInterviewId: freshId,
          }),
        ],
      );

      await notifyCancelledByUs(client, {
        applicant: applicant[0],
        cancelledInterviewId: latest[0].id,
        // Without a new interview the email belongs to the cancelled one, so
        // it still has a place in that applicant's email history.
        interviewId: freshId ?? latest[0].id,
        bookingToken: token,
      });

      await client.query('COMMIT');

      cancelMeetLink(latest[0].id).catch((error) =>
        console.error(`[fac-recruit] could not cancel the event for ${latest[0].id}:`, error.message),
      );

      return res.json({
        ok: true,
        rebook,
        bookingUrl: token
          ? `${(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/book/${token}`
          : null,
        emailLive: (await isEnabled('recruitment_alerts')) && mailMode() === 'smtp',
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[fac-recruit] cancel interview failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not cancel that interview just now.' });
    } finally {
      client.release();
    }
  });

  router.post('/applications/:id/not-attended', async (req, res) => {
    if (!(await isEnabled('recruitment_noshow_rebook'))) {
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }

    try {
      const result = await markNotAttended({ applicantId: req.params.id, actorEmail: req.admin.email });

      if (!result.ok) {
        return res.status(result.status).json({ ok: false, code: result.code, error: result.message });
      }

      console.log(
        `[fac-recruit] ${req.admin.email} marked ${req.params.id} not attended (${result.path})`,
      );
      return res.json({ ...result, emailQueued: true });
    } catch (error) {
      console.error('[fac-recruit] not attended failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not record that. Nothing was changed.' });
    }
  });

  /** Streams the CV. Not a public URL — it goes through this auth check. */
  router.get('/applications/:id/cv', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT cv_object_key, cv_filename, cv_deleted_at FROM recruit_applicants WHERE id = $1',
        [req.params.id],
      );
      const row = rows[0];
      if (row?.cv_deleted_at) {
        // Deleted on purpose, and saying so is the honest answer. "Not found"
        // would look like a bug and invite somebody to go hunting for it.
        return res.status(410).json({
          ok: false,
          error: 'That CV was deleted under our retention policy.',
        });
      }
      if (!row?.cv_object_key) return res.status(404).json({ ok: false, error: 'No CV on file.' });
      if (!(await cvExists(row.cv_object_key))) {
        return res.status(404).json({ ok: false, error: 'That file is missing from storage.' });
      }

      console.log(`[fac-recruit] ${req.admin.email} downloaded CV for ${req.params.id}`);

      // `attachment` so a PDF cannot render in-page and run anything.
      res.set('Content-Disposition', `attachment; filename="${(row.cv_filename || 'cv').replace(/"/g, '')}"`);
      res.set('Content-Type', 'application/octet-stream');
      createReadStream(resolveCv(row.cv_object_key)).pipe(res);
      return undefined;
    } catch (error) {
      console.error('[fac-recruit] cv download failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not fetch that file.' });
    }
  });

  /**
   * Streams the voice note (Sales applicants). Modelled on the CV route above,
   * and for the same reasons: not a public URL, every fetch logged against the
   * manager who made it.
   *
   * The columns are read through to_jsonb, not by name. The route is
   * registered on every deploy, and a database without recruit_016 must
   * answer "no voice note" rather than 500 -- through to_jsonb a missing
   * column simply reads as NULL.
   */
  router.get('/applications/:id/voice', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT to_jsonb(a) ->> 'voice_object_key' AS voice_object_key,
                to_jsonb(a) ->> 'voice_filename'   AS voice_filename,
                to_jsonb(a) ->> 'voice_mime'       AS voice_mime,
                to_jsonb(a) ->> 'voice_deleted_at' AS voice_deleted_at
           FROM recruit_applicants a WHERE a.id = $1`,
        [req.params.id],
      );
      const row = rows[0];
      if (row?.voice_deleted_at) {
        // Deleted on purpose, and saying so is the honest answer -- as for CVs.
        return res.status(410).json({
          ok: false,
          error: 'That voice note was deleted under our retention policy.',
        });
      }
      if (!row?.voice_object_key) {
        return res.status(404).json({ ok: false, error: 'No voice note on file.' });
      }
      if (!(await cvExists(row.voice_object_key))) {
        return res.status(404).json({ ok: false, error: 'That file is missing from storage.' });
      }

      const file = resolveCv(row.voice_object_key);
      const { size } = await stat(file);

      console.log(`[fac-recruit] ${req.admin.email} fetched voice note for ${req.params.id}`);

      // `attachment`, and the stored type echoed back only when it is audio.
      // Anything else -- or nothing -- goes out as opaque bytes, never as
      // something a browser might decide to render.
      res.set('Content-Disposition', `attachment; filename="${voiceFilename(row.voice_filename)}"`);
      res.set('Content-Type', voiceContentType(row.voice_mime));
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Accept-Ranges', 'bytes');

      // One byte range, so an <audio> element pointed straight here can seek.
      // A range we cannot satisfy is 416; no range, several ranges or anything
      // we do not parse gets the whole file, which is always a correct answer.
      const range = parseRange(req.headers.range, size);
      if (range === 'unsatisfiable') {
        res.set('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      if (range) {
        res.status(206);
        res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        res.set('Content-Length', String(range.end - range.start + 1));
        createReadStream(file, range).pipe(res);
        return undefined;
      }
      res.set('Content-Length', String(size));
      createReadStream(file).pipe(res);
      return undefined;
    } catch (error) {
      console.error('[fac-recruit] voice download failed:', error.message);
      return res.status(503).json({ ok: false, error: 'Could not fetch that file.' });
    }
  });

  return router;
}

export default createAdminRouter;
