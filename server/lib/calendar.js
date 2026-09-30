import { pool } from './db.js';
import { RULES_FOR_INTERVIEWER, pickRule } from './roleRules.js';
import {
  addDays,
  formatTimeIn,
  parseClock,
  zonedDateParts,
  zonedTimeToInstant,
} from './zonedTime.js';

/**
 * The manager's calendar.
 *
 * Read-only, and deliberately so: it shows what the portal already knows —
 * interviews that were booked, time that was blocked, hours that were
 * configured. Nothing here decides anything. A slot it draws as free is free
 * because the availability engine says so, and booking one still goes through
 * that engine, the advisory lock and the exclusion constraint exactly as a
 * candidate's booking does.
 *
 * The grid is built HERE rather than in the browser. Working out which
 * instants make up 09:00–17:00 in Europe/London, across a clock change, is the
 * kind of arithmetic that should exist once — and it already exists here, in
 * the same file the candidate's slot list comes from. A second implementation
 * in the client would be a second chance to get the last Sunday in October
 * wrong.
 */

const INTERVIEWS = `
  SELECT i.id, i.starts_at, i.ends_at, i.status, i.meet_link,
         a.id AS applicant_id, a.full_name, a.email, a.role,
         a.final_score, a.candidate_tz,
         -- For the popup's colours and buttons. Through to_jsonb so the
         -- calendar cannot break on a database without recruit_015.
         COALESCE((to_jsonb(i) ->> 'is_final_chance')::boolean, false) AS is_final_chance,
         -- Attendance buttons act on the applicant's LATEST interview with a
         -- time; offering them on an older slot would mark a different one.
         NOT EXISTS (
           SELECT 1 FROM recruit_interviews l
            WHERE l.applicant_id = i.applicant_id
              AND l.starts_at IS NOT NULL
              AND l.created_at > i.created_at
         ) AS is_latest
    FROM recruit_interviews i
    JOIN recruit_applicants a ON a.id = i.applicant_id
   WHERE i.interviewer_id = $1
     AND i.starts_at IS NOT NULL
     AND i.status <> 'cancelled'
     AND i.starts_at < $3
     AND i.ends_at > $2
   ORDER BY i.starts_at
`;

const BLACKOUTS = `
  SELECT id, starts_at, ends_at, reason
    FROM recruit_blackouts
   WHERE interviewer_id = $1
     AND starts_at < $3
     AND ends_at > $2
   ORDER BY starts_at
`;

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * The calendar's own grid, separate from the booking hours.
 *
 * It used to be built from the booking rule itself -- day_start to day_end in
 * steps of slot_minutes -- so changing the booking hours in Settings squeezed
 * the calendar, and an interview booked under the old hours dropped off it.
 * Decided 17 Sep: the calendar is always 09:00-18:00 in 30-minute rows,
 * stretched only as far as needed to show booking hours or an interview that
 * fall outside it. The booking hours decide which rows are bookable; they no
 * longer decide which rows exist. Candidates' slots are untouched -- they come
 * from the availability engine, not from this.
 */
export const GRID = Object.freeze({ start: 9 * 60, end: 18 * 60, step: 30 });

/*
 * Rows are the interview length (decided 22 Sep). With 30-minute rows and
 * 20-minute interviews, two interviews started in one row (13:30 and 13:50)
 * and only one of them could carry its name; the other vanished from the
 * calendar. So a row is now one slot from Settings, counted from the booking
 * day's start -- the same arithmetic the availability engine uses to offer
 * slots (availability.js), so every bookable time begins a row of its own.
 * The window is still 09:00-18:00, stretched for anything outside it.
 *
 * Bounded, so a mistyped slot length cannot draw a thousand rows or one.
 */
export const ROW_MINUTES = Object.freeze({ min: 10, max: 120 });

export const rowStepFor = (slotMinutes) => {
  const n = Number(slotMinutes);
  if (!Number.isFinite(n) || n <= 0) return GRID.step;
  return Math.min(ROW_MINUTES.max, Math.max(ROW_MINUTES.min, Math.round(n)));
};

// Rounded to the grid's own rows: multiples of `step` counted from `anchor`.
// With the defaults (anchor 0, 30-minute step) these are the plain :00/:30
// roundings the calendar has always used.
const floorTo = (minute, step, anchor = 0) => anchor + Math.floor((minute - anchor) / step) * step;
const ceilTo = (minute, step, anchor = 0) => anchor + Math.ceil((minute - anchor) / step) * step;

/**
 * First and last minute of the grid, the same for every day in the range so
 * the rows line up across the week.
 *
 * @param spans  minutes-of-day, `{ from, to }`, for every interview in range
 * @param step   row length in minutes (the slot length)
 * @param anchor a minute rows are aligned to (the booking day's start)
 */
export function gridBounds({ dayStart, dayEnd, spans = [], step = GRID.step, anchor = 0 }) {
  let start = Math.min(floorTo(GRID.start, step, anchor), floorTo(dayStart, step, anchor));
  let end = Math.max(ceilTo(GRID.end, step, anchor), ceilTo(dayEnd, step, anchor));
  for (const { from, to } of spans) {
    start = Math.min(start, floorTo(from, step, anchor));
    end = Math.max(end, ceilTo(to, step, anchor));
  }
  // Clamped to the day, and still whole rows: a start pushed below midnight
  // moves up to the first aligned row of the day.
  if (start < 0) start = ceilTo(0, step, anchor);
  return { start, end: Math.min(24 * 60, end) };
}

/**
 * What one 30-minute row is.
 *
 * Same order of precedence as before -- a booked interview first, so it is
 * visible whatever else is true of its time -- with one new state: a row on a
 * working day that the booking hours do not cover is `outside`. It is shown,
 * not bookable, and not blockable (there is nothing to block).
 */
export function rowState({
  minute,
  working,
  dayStart,
  dayEnd,
  block,
  interview,
  blackout,
  startsAt,
  earliest,
  step = GRID.step,
}) {
  if (interview) return 'booked';
  if (blackout) return 'blocked';
  if (!working) return 'closed';
  if (minute < dayStart || minute + step > dayEnd) return 'outside';
  if (block) return 'break';
  if (startsAt < earliest) return 'past';
  return 'free';
}

/** An interview's start and end as minutes past midnight in `zone`. */
export function minutesOfDay(startsAt, endsAt, zone) {
  const from = parseClock(formatTimeIn(new Date(startsAt), zone)) % (24 * 60);
  let to = parseClock(formatTimeIn(new Date(endsAt), zone)) % (24 * 60);
  // Ends at or past midnight: run the grid to the end of the day.
  if (to <= from) to = 24 * 60;
  return { from, to };
}

/**
 * Builds the grid for a date range.
 *
 * Dates come in as plain `YYYY-MM-DD` because that is what a calendar is: the
 * manager asked for "this week", not for an instant. They are resolved against
 * the interviewer's own timezone, so the week shown is the week they work.
 */
export async function buildCalendar({ interviewerId, from, to, now = new Date() }) {
  /*
   * The DEFAULT rule, deliberately -- not whichever row the database returns
   * first. Since recruit_018 an interviewer can also have hours per role, and
   * this one grid cannot be four sets of hours at once: it draws the default
   * day, and an interview outside it still appears, because `gridBounds`
   * stretches for every interview and `rowState` calls a booked row booked
   * before it asks about the hours.
   */
  const { rows: ruleRows } = await pool.query(RULES_FOR_INTERVIEWER, [interviewerId]);
  const rule = pickRule(ruleRows, null);
  if (!rule) return null;

  const zone = rule.timezone;
  const start = zonedTimeToInstant({ ...parseDate(from), hour: 0 }, zone);
  // Exclusive: midnight at the start of the day AFTER the last one asked for.
  const end = zonedTimeToInstant({ ...addDays(parseDate(to), 1), hour: 0 }, zone);

  const [{ rows: interviews }, { rows: blackouts }] = await Promise.all([
    pool.query(INTERVIEWS, [interviewerId, start, end]),
    pool.query(BLACKOUTS, [interviewerId, start, end]),
  ]);

  const dayStart = parseClock(rule.day_start);
  const dayEnd = parseClock(rule.day_end);
  const step = rowStepFor(rule.slot_minutes);
  const grid = gridBounds({
    dayStart,
    dayEnd,
    step,
    anchor: dayStart,
    spans: interviews.map((i) => minutesOfDay(i.starts_at, i.ends_at, zone)),
  });
  const weekdays = new Set(rule.weekdays);
  const blocks = (rule.blocks ?? []).map((b) => ({
    start: parseClock(b.start),
    end: parseClock(b.end),
    label: b.label ?? 'Blocked',
  }));

  // The earliest a candidate could still take. Slots before it are drawn as
  // past rather than free, so an empty morning does not read as availability
  // nobody took.
  const earliest = new Date(now.getTime() + rule.min_notice_hours * 3_600_000);

  const days = [];
  let cursor = parseDate(from);
  const last = parseDate(to);

  while (!isAfter(cursor, last)) {
    // Ask the zone what weekday this is, at midday — computing it from a UTC
    // date is a day out either side of midnight.
    const probe = zonedTimeToInstant({ ...cursor, hour: 12 }, zone);
    const { weekday } = zonedDateParts(probe, zone);
    const working = weekdays.has(weekday);

    const slots = [];
    for (let minute = grid.start; minute + step <= grid.end; minute += step) {
      const startsAt = zonedTimeToInstant(
        { ...cursor, hour: Math.floor(minute / 60), minute: minute % 60 },
        zone,
      );
      const endsAt = new Date(startsAt.getTime() + step * 60_000);

      const block = blocks.find((b) => minute < b.end && b.start < minute + step);
      // An interview that STARTS in this row wins over one still running into
      // it, so back-to-back interviews that share a row (09:00-09:45 then
      // 09:45-10:30) each get a row that shows their name.
      const touching = interviews.filter((i) =>
        overlaps(startsAt, endsAt, new Date(i.starts_at), new Date(i.ends_at)),
      );
      const interview =
        touching.find((i) => new Date(i.starts_at) >= startsAt) ?? touching[0];
      // Every interview in the row, not only the one above: after a change of
      // slot length (or in an older week) a row can hold the end of one
      // interview and the start of the next, and each must stay visible.
      // Continuing ones first, then those starting here, each by start time.
      const inRow = [
        ...touching.filter((i) => new Date(i.starts_at) < startsAt),
        ...touching.filter((i) => new Date(i.starts_at) >= startsAt),
      ];
      const blackout = blackouts.find((b) =>
        overlaps(startsAt, endsAt, new Date(b.starts_at), new Date(b.ends_at)),
      );

      // Order matters: a booked interview is the most important thing a cell
      // can say, and it stays visible even if the day was later blocked -- or
      // the booking hours later moved away from it. Closed beats the lunch
      // break: on a Saturday the whole day is shut. See rowState.
      const state = rowState({
        minute,
        working,
        dayStart,
        dayEnd,
        block,
        interview,
        blackout,
        startsAt,
        earliest,
        step,
      });

      const describe = (i) => ({
        id: i.id,
        applicantId: i.applicant_id,
        fullName: i.full_name,
        email: i.email,
        role: i.role,
        score: i.final_score,
        status: i.status,
        localTime: formatTimeIn(i.starts_at, i.candidate_tz),
        candidateTz: i.candidate_tz,
        // Already selected above and never passed on, so the calendar
        // showed everything about a booking except how to join it.
        meetLink: i.meet_link ?? null,
        startsAt: new Date(i.starts_at).toISOString(),
        endsAt: new Date(i.ends_at).toISOString(),
        isFinalChance: i.is_final_chance === true,
        isLatest: i.is_latest === true,
        // Began in an earlier row and runs on into this one.
        continued: new Date(i.starts_at) < startsAt,
      });

      slots.push({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        time: formatTimeIn(startsAt, zone),
        state,
        ...(block ? { breakLabel: block.label } : {}),
        ...(blackout ? { blackoutId: blackout.id, blackoutReason: blackout.reason } : {}),
        // `interview` is the row's main one, as before; `interviews` is every
        // interview the row touches, so none is ever hidden behind another.
        ...(interview ? { interview: describe(interview), interviews: inRow.map(describe) } : {}),
      });
    }

    days.push({
      date: `${cursor.year}-${pad(cursor.month)}-${pad(cursor.day)}`,
      weekday,
      working,
      slots,
      // Counted here so the month view does not have to walk every slot.
      // Interviews, not rows: one 45-minute interview fills two rows but is
      // one booking.
      booked: new Set(slots.flatMap((s) => (s.interviews ?? []).map((i) => i.id))).size,
      blocked: slots.filter((s) => s.state === 'blocked').length,
      free: slots.filter((s) => s.state === 'free').length,
    });

    cursor = addDays(cursor, 1);
  }

  return {
    timezone: zone,
    dayStart: rule.day_start,
    dayEnd: rule.day_end,
    slotMinutes: step,
    days,
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** `2026-09-08` → `{ year, month, day }`. Throws rather than guessing. */
function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw Object.assign(new Error('Dates must look like 2026-09-08.'), { status: 400 });
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

const isAfter = (a, b) =>
  a.year > b.year ||
  (a.year === b.year && (a.month > b.month || (a.month === b.month && a.day > b.day)));
