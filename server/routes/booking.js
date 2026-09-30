import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../lib/db.js';
import { hashBookingToken } from '../lib/bookingToken.js';
import { buildAvailability, isSlotBookable } from '../lib/availability.js';
import { formatDayIn, formatTimeIn } from '../lib/zonedTime.js';
import { notifyBooked, notifyCancelled } from '../lib/notify.js';
import { blackoutsFor } from '../lib/blackouts.js';
import { RULES_FOR_INTERVIEWER, pickRule } from '../lib/roleRules.js';
import { isEnabled, requireFlag } from '../lib/flags.js';
import { cancelGuard } from '../lib/rebookPolicy.js';
import { attachMeetLink, moveMeetLink, cancelMeetLink } from '../lib/meetLink.js';

/**
 * Candidate self-service booking.
 *
 * Every route is reached with a token and nothing else — there is no login,
 * because the candidate has no account. The token is the credential, so it is
 * looked up by hash, checked for expiry, and never echoed back.
 *
 * Concurrency is handled in two layers. This code takes a Postgres advisory
 * lock on the interviewer and re-checks availability inside it, which produces
 * a civil "just taken" message. Underneath, an exclusion constraint on the
 * table makes an overlapping booking impossible regardless — so even if this
 * logic were wrong, two candidates could not end up in the same slot.
 */

// One lock namespace for interviewer booking. Arbitrary but fixed: two
// different features using the same number would block each other.
const LOCK_NAMESPACE = 4711;

const FIND_BY_TOKEN = `
  SELECT i.id, i.status, i.starts_at, i.ends_at, i.reschedule_count, i.token_expires_at,
         i.meet_link, i.interviewer_id,
         -- Through to_jsonb, not by name: every booking page load runs this, and
         -- naming a column recruit_015 adds would break booking outright if the
         -- code reached production before that migration.
         COALESCE((to_jsonb(i) ->> 'is_final_chance')::boolean, false) AS is_final_chance,
         a.id AS applicant_id, a.full_name, a.email, a.role, a.candidate_tz,
         iv.full_name AS interviewer_name
    FROM recruit_interviews i
    JOIN recruit_applicants a   ON a.id = i.applicant_id
    JOIN recruit_interviewers iv ON iv.id = i.interviewer_id
   WHERE i.booking_token_hash = $1
`;

/*
 * Every rule this interviewer has; `pickRule` takes the one for the
 * candidate's role, or the default when that role has none (recruit_018).
 * A database without that migration has one row, no role, and this resolves
 * to exactly what it always did.
 */
const RULE_FOR = RULES_FOR_INTERVIEWER;

const TAKEN_FOR = `
  SELECT starts_at AS "startsAt", ends_at AS "endsAt"
    FROM recruit_interviews
   WHERE interviewer_id = $1 AND status = 'booked' AND starts_at IS NOT NULL
     AND ($2::uuid IS NULL OR id <> $2)
`;

const MAX_RESCHEDULES = 2;
const RESCHEDULE_CUTOFF_MS = 2 * 3_600_000;

/**
 * Everything the booking page shows about who they are meeting.
 *
 * `canCancel` defaults to true, so any caller that does not pass it gets the
 * page exactly as it was. It is false only for a final chance while the
 * no-show re-book is switched on -- the page then hides the button, and the
 * cancel route refuses it regardless of what the page shows.
 */
const publicInterview = (row, { canCancel = true } = {}) => ({
  firstName: (row.full_name ?? '').split(' ')[0],
  canCancel,
  role: row.role,
  interviewerName: row.interviewer_name,
  status: row.status,
  rescheduleCount: row.reschedule_count,
  maxReschedules: MAX_RESCHEDULES,
  ...(row.starts_at
    ? {
        booked: {
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          localTime: formatTimeIn(row.starts_at, row.candidate_tz),
          localDay: formatDayIn(row.starts_at, row.candidate_tz),
          ukTime: formatTimeIn(row.starts_at, 'Europe/London'),
          meetLink: row.meet_link,
        },
      }
    : {}),
});

export function createBookingRouter() {
  const router = Router();

  const limiter = rateLimit({
    windowMs: Number(process.env.BOOK_RATE_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.BOOK_RATE_MAX || 60),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests. Please wait a moment and try again.' },
  });

  router.use(limiter);
  // Spec §2. Off by default, so booking can be deployed and watched before a
  // candidate can reach it.
  router.use(
    requireFlag(
      'recruitment_booking',
      'Interview booking is not open yet. Please reply to your invitation email and we will arrange a time.',
    ),
  );
  // A booking page is personal to one candidate and changes as slots go — it
  // must never be cached by a proxy or served from the back-forward cache.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    next();
  });

  /** Loads the interview behind a token, or answers for us why it cannot. */
  async function loadByToken(token) {
    const { rows } = await pool.query(FIND_BY_TOKEN, [hashBookingToken(token)]);
    const row = rows[0];

    // The same response for "no such token" and "expired token": telling the
    // difference would let someone probe for valid links.
    if (!row) return { error: { status: 404, body: { ok: false, error: 'expired' } } };
    if (new Date(row.token_expires_at) < new Date()) {
      return { error: { status: 410, body: { ok: false, error: 'expired' } } };
    }
    if (row.status === 'cancelled') {
      return { error: { status: 410, body: { ok: false, error: 'cancelled' } } };
    }
    return { row };
  }

  async function loadContext(row, excludeSelf = true) {
    const [{ rows: ruleRows }, { rows: taken }, blackouts] = await Promise.all([
      pool.query(RULE_FOR, [row.interviewer_id]),
      pool.query(TAKEN_FOR, [row.interviewer_id, excludeSelf ? row.id : null]),
      blackoutsFor(row.interviewer_id),
    ]);
    // `taken` is deliberately NOT narrowed by role: the interviewer is one
    // person whatever the candidate applied for, and a slot another role has
    // taken is gone.
    // One list of periods to avoid. A slot the interviewer has blacked out and
    // a slot another candidate has taken are the same thing to the engine, and
    // calendar busy periods will join this list unchanged.
    return { rule: pickRule(ruleRows, row.role), taken: [...taken, ...blackouts] };
  }

  // ── The booking page ──────────────────────────────────────────────────────
  router.get('/:token', async (req, res) => {
    try {
      const { row, error } = await loadByToken(req.params.token);
      if (error) return res.status(error.status).json(error.body);

      const { rule, taken } = await loadContext(row);
      if (!rule) return res.status(503).json({ ok: false, error: 'No availability is configured.' });

      const days = buildAvailability({
        rule,
        taken,
        candidateTimezone: row.candidate_tz,
      });

      return res.json({
        ok: true,
        interview: publicInterview(row, {
          canCancel: !cancelGuard({ flagOn: await isEnabled('recruitment_noshow_rebook'), interview: row }),
        }),
        timezone: row.candidate_tz,
        days,
        // The page explains why there is a gap in the middle of the day. It
        // used to say "lunch (11:30-12:30 UK)" in prose, which silently became
        // a lie the first time anyone moved lunch. These are the rule's own
        // wall-clock windows, in its own zone, so the sentence cannot drift
        // from the slots beside it.
        blocks: Array.isArray(rule.blocks) ? rule.blocks : [],
        rulesTimezone: rule.timezone,
      });
    } catch (err) {
      console.error('[fac-recruit] booking load failed:', err.message);
      return res.status(503).json({ ok: false, error: 'Could not load your booking page.' });
    }
  });

  // ── Choosing a slot, and moving it ────────────────────────────────────────
  async function book(req, res, { isReschedule }) {
    const { row, error } = await loadByToken(req.params.token);
    if (error) return res.status(error.status).json(error.body);

    if (!isReschedule && row.status === 'booked') {
      return res.status(409).json({ ok: false, error: 'This interview is already booked.' });
    }
    if (isReschedule) {
      if (row.status !== 'booked') {
        return res.status(409).json({ ok: false, error: 'There is no booking to move.' });
      }
      if (row.reschedule_count >= MAX_RESCHEDULES) {
        return res.status(409).json({
          ok: false,
          error: 'This interview has already been rescheduled twice. Please reply to your invitation email.',
        });
      }
      if (new Date(row.starts_at).getTime() - Date.now() < RESCHEDULE_CUTOFF_MS) {
        return res.status(409).json({
          ok: false,
          error: 'Interviews can only be moved up to 2 hours beforehand. Please reply to your invitation email.',
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise bookings for this interviewer. Held until commit, so the
      // re-check below cannot race another request between check and write.
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, row.interviewer_id]);

      const { rows: ruleRows } = await client.query(RULE_FOR, [row.interviewer_id]);
      const { rows: taken } = await client.query(TAKEN_FOR, [row.interviewer_id, row.id]);
      const rule = pickRule(ruleRows, row.role);
      if (!rule) throw new Error('no availability rule');

      // Re-checked here as well as when the list was drawn: a blackout added
      // in the last two minutes has to beat a page opened before it.
      const blocked = await blackoutsFor(row.interviewer_id);

      const check = isSlotBookable({
        startsAt: req.body?.startsAt,
        rule,
        taken: [...taken, ...blocked],
      });
      if (!check.ok) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: check.reason });
      }

      await client.query(
        `UPDATE recruit_interviews
            SET status = 'booked', starts_at = $2, ends_at = $3,
                reschedule_count = reschedule_count + $4, updated_at = now()
          WHERE id = $1`,
        [row.id, check.startsAt, check.endsAt, isReschedule ? 1 : 0],
      );

      await client.query(
        `INSERT INTO recruit_audit (applicant_id, action, payload)
         SELECT applicant_id, $2, $3 FROM recruit_interviews WHERE id = $1`,
        [row.id, isReschedule ? 'rescheduled' : 'booked', JSON.stringify({ startsAt: check.startsAt })],
      );

      // The confirmation and both reminders, queued in the booking's own
      // transaction. On a reschedule this also calls off whatever was queued
      // for the old time — the candidate must not be reminded about a slot
      // they have already moved away from.
      await notifyBooked(client, {
        applicant: { id: row.applicant_id, email: row.email, full_name: row.full_name, role: row.role },
        interviewId: row.id,
        startsAt: check.startsAt,
        isReschedule,
      });

      await client.query('COMMIT');

      // AFTER the commit, and deliberately. The transaction above holds an
      // advisory lock on the interviewer; a call to Google inside it would put
      // every other candidate booking this interviewer behind a third party's
      // network, timeouts and outages.
      //
      // Not awaited into the response either: the candidate has booked, and
      // whether Google answered in the next second is not their problem. The
      // confirmation email drains about thirty seconds from now and re-reads
      // meet_link when it does, so in practice it carries the link; when it
      // does not, the wording degrades honestly and the sweep fills it in
      // long before the T-24h reminder.
      const linkWork = isReschedule ? moveMeetLink(row.id) : attachMeetLink(row.id);
      linkWork.catch((error) =>
        console.error(`[fac-recruit] Meet link work failed for ${row.id}:`, error.message),
      );

      return res.json({
        ok: true,
        booked: {
          startsAt: check.startsAt.toISOString(),
          endsAt: check.endsAt.toISOString(),
          localDay: formatDayIn(check.startsAt, row.candidate_tz),
          localTime: formatTimeIn(check.startsAt, row.candidate_tz),
          ukTime: formatTimeIn(check.startsAt, 'Europe/London'),
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // 23P01 = exclusion_violation: the database caught a clash this code
      // did not. Rare, and exactly what that constraint is there for.
      if (err.code === '23P01') {
        return res.status(409).json({ ok: false, error: 'That time has just been taken. Please choose another.' });
      }
      console.error('[fac-recruit] booking failed:', err.message);
      return res.status(503).json({ ok: false, error: 'Could not save your booking. Please try again.' });
    } finally {
      client.release();
    }
  }

  router.post('/:token', (req, res) => book(req, res, { isReschedule: false }));
  router.post('/:token/reschedule', (req, res) => book(req, res, { isReschedule: true }));

  // ── Cancelling ────────────────────────────────────────────────────────────
  router.post('/:token/cancel', async (req, res) => {
    try {
      const { row, error } = await loadByToken(req.params.token);
      if (error) return res.status(error.status).json(error.body);

      // A final chance cannot be cancelled online (decided 15 Sep). Checked
      // here, not only by hiding the button, because a request can be sent
      // without the page. Switch off: cancelling works exactly as before.
      const blocked = cancelGuard({ flagOn: await isEnabled('recruitment_noshow_rebook'), interview: row });
      if (blocked) return res.status(409).json({ ok: false, code: blocked.code, error: blocked.message });

      // The slot is deliberately kept on the row. "They cancelled twice, and
      // when" is a question worth being able to answer later.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE recruit_interviews SET status = 'cancelled', updated_at = now() WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `INSERT INTO recruit_audit (applicant_id, action, payload)
           SELECT applicant_id, 'cancelled', $2 FROM recruit_interviews WHERE id = $1`,
          [row.id, JSON.stringify({ wasStartingAt: row.starts_at })],
        );

        // Acknowledges it, and — the part that matters — cancels the reminders
        // still queued for a slot nobody is turning up to.
        await notifyCancelled(client, {
          applicant: { id: row.applicant_id, email: row.email, full_name: row.full_name, role: row.role },
          interviewId: row.id,
        });

        await client.query('COMMIT');

        // Same reasoning, and the same place: nobody should be left holding an
        // invitation to an interview that is not happening.
        cancelMeetLink(row.id).catch((error) =>
          console.error(`[fac-recruit] could not cancel the event for ${row.id}:`, error.message),
        );
      } catch (failure) {
        await client.query('ROLLBACK').catch(() => {});
        throw failure;
      } finally {
        client.release();
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('[fac-recruit] cancel failed:', err.message);
      return res.status(503).json({ ok: false, error: 'Could not cancel. Please try again.' });
    }
  });

  return router;
}

export default createBookingRouter;
