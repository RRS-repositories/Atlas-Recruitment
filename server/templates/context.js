import { ROLE_BY_API_KEY } from '../lib/roles.js';
import { extendedRole } from '../lib/extendedRoles.js';
import { extraGuests } from '../lib/googleCalendar.js';
import { formatDayIn, formatTimeIn } from '../lib/zonedTime.js';
import { declineReapply, declineSentence } from '../../shared/declineReasons.js';

/**
 * What every email needs to know, fetched at the moment of sending.
 *
 * This is the function that makes "resolve merge fields late" real. A reminder
 * queued twenty-four hours ago asks this for the interview time now, so a
 * candidate who moved their slot in the meantime is told the time they
 * actually have — not the one they had when the reminder was written.
 *
 * Every field is safe to interpolate into a plain-text email. Nothing here is
 * a secret: the booking token cannot be re-derived and travels separately, in
 * the queued row's `vars`.
 */

const UK = 'Europe/London';

const ONE = `
  SELECT a.id            AS applicant_id,
         a.full_name, a.email, a.role, a.candidate_tz, a.status AS applicant_status,
         a.decline_reason, a.decline_reason_note,
         i.id            AS interview_id,
         i.starts_at, i.ends_at, i.status AS interview_status,
         i.meet_link, i.reschedule_count,
         -- Read through to_jsonb rather than as i.is_final_chance, and that is
         -- deliberate. EVERY email resolves its fields through this query, and
         -- the column arrives with recruit_015. Named directly, code deployed a
         -- minute before that migration would stop every candidate email --
         -- the exact shape of the 11 Sep outage, where new code met an old
         -- schema. Through to_jsonb a missing column reads as NULL, so the
         -- order of deploy and migration cannot take email down.
         COALESCE((to_jsonb(i) ->> 'is_final_chance')::boolean, false) AS is_final_chance,
         iv.full_name    AS interviewer_name,
         iv.email        AS interviewer_email,
         iv.personal_timezone AS interviewer_tz
    FROM recruit_applicants a
    LEFT JOIN recruit_interviews i  ON i.id = $2
    LEFT JOIN recruit_interviewers iv ON iv.id = i.interviewer_id
   WHERE a.id = $1
`;

/** "Priyanshu Srivastava" → "Priyanshu". Used to sign off warmly but briefly. */
const firstNameOf = (full) => (full ?? '').trim().split(/\s+/)[0] ?? '';

/**
 * Where booking links point.
 *
 * In production this is the public hostname; in development it is the dev
 * server, so a link in a file-written email is one you can actually click.
 */
export const publicBaseUrl = () =>
  (process.env.PUBLIC_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');

/** The first address a role adds to its own interviews, or null. */
function salesChatInterviewer(apiKey) {
  const key = extendedRole(apiKey)?.calendar?.extraGuestsEnv;
  return (key ? extraGuests(process.env, key)[0] : null) ?? null;
}

export async function loadContext(row, db) {
  const { rows } = await db.query(ONE, [row.applicant_id, row.interview_id]);
  const record = rows[0];
  if (!record) throw new Error(`applicant ${row.applicant_id} no longer exists`);

  const role = ROLE_BY_API_KEY[record.role] ?? null;
  const tz = record.candidate_tz || role?.timezone || UK;

  const context = {
    firstName: firstNameOf(record.full_name),
    fullName: record.full_name,
    email: record.email,

    roleTitle: role?.title ?? 'the role',
    // The role as the "Application received" email names it. "the Paralegal
    // Internship" reads whole; "the Sales & Customer Service" does not, so the
    // extended roles say "position". The original roles are the title alone,
    // exactly as that email has always read.
    roleApplied: extendedRole(record.role) ? `${role?.title ?? 'the role'} position` : (role?.title ?? 'the role'),
    roleCountry: role?.country ?? '',
    roleSlug: role?.slug ?? '',

    interviewerName: record.interviewer_name ?? 'a member of our team',
    // Who the Mattermost post names as the interviewer. A role that puts its
    // own people on its interviews (Sales, via the same .env list as the Meet
    // invite) names the first of them there instead: for that role they are
    // the person taking the interview, and the channel should say so. Every
    // other role names the interviewer, exactly as before.
    chatInterviewer:
      salesChatInterviewer(record.role) ?? record.interviewer_name ?? 'a member of our team',
    interviewerFirstName: firstNameOf(record.interviewer_name),
    interviewerEmail: record.interviewer_email ?? null,
    interviewerTimezone: record.interviewer_tz || UK,

    applicantStatus: record.applicant_status,
    interviewStatus: record.interview_status,
    rescheduleCount: record.reschedule_count ?? 0,
    meetLink: record.meet_link ?? null,
    // True only for a re-book offered after a no-show. The booking confirmation
    // adds one line when it is.
    isFinalChance: record.is_final_chance === true,

    // The decline reason as a finished sentence, or null. Resolved here, at
    // SEND time, like everything else — so a reason corrected in the minute
    // between the decision and the email going out is the one the candidate
    // reads.
    declineSentence: declineSentence(record.decline_reason, record.decline_reason_note),

    // The invitation to apply again, for the reasons that carry one. Also
    // resolved here rather than at queue time, so a manager who corrects
    // the reason before the email leaves changes both halves together.
    declineReapply: declineReapply(record.decline_reason),
    reapplyUrl: publicBaseUrl(),

    // Filled in below only when there is a time to talk about.
    localDay: null,
    localTime: null,
    ukTime: null,
    // The same instant in the interviewer's own day. Their zone is not the
    // candidate's and need not be the UK one either, so the email that tells
    // them to be somewhere has to say it in the time they live in.
    interviewerDay: null,
    interviewerTime: null,
    timezone: tz,
    startsAt: record.starts_at ?? null,
    endsAt: record.ends_at ?? null,
  };

  if (record.starts_at) {
    // Both zones, always. A cross-timezone interview that names one bare time
    // is how people join an hour late.
    context.localDay = formatDayIn(record.starts_at, tz);
    context.localTime = formatTimeIn(record.starts_at, tz);
    context.ukTime = formatTimeIn(record.starts_at, UK);
    context.interviewerDay = formatDayIn(record.starts_at, context.interviewerTimezone);
    context.interviewerTime = formatTimeIn(record.starts_at, context.interviewerTimezone);
  }

  return context;
}

/** The sign-off every email shares, so it cannot drift between them. */
export const SIGN_OFF = 'Kind regards,\nRecruitment Team\nFast Action Claims\nRowan Rose Ltd';

/**
 * The line that names the time, in both zones.
 *
 * One function rather than seven copies: if the wording changes, it changes
 * everywhere, and no email can end up disagreeing with another about how a
 * time is written.
 */
export const whenLine = (data) =>
  data.localDay && data.localTime
    ? `${data.localDay} at ${data.localTime} (${data.ukTime} UK time)`
    : 'a time still to be chosen';

/**
 * What to say about joining.
 *
 * `meet_link` is filled automatically once a slot is booked. Until it is —
 * because the calendar is off, or Google was unreachable — promising a link
 * that nothing creates would be a lie the candidate discovers on the day, so
 * the wording changes with the fact and improves on its own when the column
 * fills.
 *
 * THE SHAPE OF THIS STRING IS LOAD-BEARING. `htmlFromText` turns a block that
 * reads "Label: https://..." into a real button, and anything else into a
 * paragraph. So the text before the colon becomes the button's label — and the
 * line must be its own block, with a blank line either side of it, or it is
 * swallowed into the preceding paragraph and renders as a bare link. That is
 * exactly what it did in three of the five emails that use it.
 */
export const joinLine = (data) =>
  data.meetLink
    ? `Join the interview: ${data.meetLink}`
    : 'We will email you the video link before your interview.';
