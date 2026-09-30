import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RULES_FOR_INTERVIEWER, pickRule } from './roleRules.js';
import { buildAvailability, isSlotBookable } from './availability.js';

/**
 * Booking hours per role (recruit_018).
 *
 * The India roles are interviewed 11:30-13:30 India time; every other role
 * keeps the hours the single rule has always carried. What matters is that a
 * role WITHOUT its own hours is indistinguishable from before, and that the
 * India hours are 11:30 in India whatever the UK clock is doing -- which is
 * why that rule carries its own timezone rather than a converted UK time.
 */

const DEFAULT_RULE = {
  id: 1,
  interviewer_id: 1,
  rule_role: null,
  timezone: 'Europe/London',
  weekdays: [1, 2, 3, 4, 5],
  day_start: '13:30:00',
  day_end: '16:30:00',
  slot_minutes: 20,
  buffer_minutes: 0,
  min_notice_hours: 24,
  max_days_ahead: 14,
  blocks: [{ start: '12:30', end: '13:15', label: 'Lunch' }],
};

const INDIA_RULE = {
  ...DEFAULT_RULE,
  id: 2,
  rule_role: 'india_intern',
  timezone: 'Asia/Kolkata',
  day_start: '11:30:00',
  day_end: '13:30:00',
  blocks: [],
};

const AIDEV_RULE = { ...INDIA_RULE, id: 3, rule_role: 'india_aidev' };
const ALL = [DEFAULT_RULE, INDIA_RULE, AIDEV_RULE];

/* ── which rule applies ──────────────────────────────────────────────────── */

test('a role with its own hours uses them; every other role uses the default', () => {
  assert.equal(pickRule(ALL, 'india_intern'), INDIA_RULE);
  assert.equal(pickRule(ALL, 'india_aidev'), AIDEV_RULE);
  assert.equal(pickRule(ALL, 'sa_paralegal'), DEFAULT_RULE);
  assert.equal(pickRule(ALL, 'sa_sales'), DEFAULT_RULE);
});

test('no role, an unknown role, or no rules at all', () => {
  assert.equal(pickRule(ALL, null), DEFAULT_RULE);
  assert.equal(pickRule(ALL, undefined), DEFAULT_RULE);
  assert.equal(pickRule(ALL, 'not_a_role'), DEFAULT_RULE);
  assert.equal(pickRule([], 'india_intern'), null);
  assert.equal(pickRule(null, 'india_intern'), null);
});

test('a database without recruit_018 behaves exactly as before', () => {
  // No `role` column: the query reads it through to_jsonb, so rule_role is
  // undefined on every row and every role gets the one rule there is.
  const old = [{ ...DEFAULT_RULE, rule_role: undefined }];
  for (const role of ['india_intern', 'sa_paralegal', 'sa_sales', 'india_aidev', null]) {
    assert.equal(pickRule(old, role), old[0], String(role));
  }
});

test('the query asks for every rule of one interviewer, and narrows by nothing else', () => {
  assert.match(RULES_FOR_INTERVIEWER, /FROM recruit_availability_rules/);
  assert.match(RULES_FOR_INTERVIEWER, /WHERE r\.interviewer_id = \$1/);
  // Through to_jsonb so the query still runs before the migration.
  assert.match(RULES_FOR_INTERVIEWER, /to_jsonb\(r\) ->> 'role'/);
});

/* ── what a candidate is actually offered ────────────────────────────────── */

const DAYS = (rule, tz) =>
  buildAvailability({ rule, taken: [], candidateTimezone: tz, now: new Date('2026-10-01T06:00:00Z') });

test('an India candidate is offered 11:30-13:30 in their own time', () => {
  const days = DAYS(INDIA_RULE, 'Asia/Kolkata').filter((d) => d.slots.length);
  assert.ok(days.length > 0, 'there are days to book');
  const times = [...new Set(days.flatMap((d) => d.slots.map((s) => s.localLabel ?? s.label ?? s.localTime)))];
  for (const day of days) {
    assert.equal(day.slots[0].localTime ?? day.slots[0].label, '11:30', 'first slot');
    const last = day.slots.at(-1);
    assert.equal(last.localTime ?? last.label, '13:10', 'last slot starts 20 minutes before 13:30');
    assert.equal(day.slots.length, 6, 'six 20-minute slots in two hours');
  }
  assert.ok(times.every((t) => t >= '11:30' && t <= '13:30'), 'nothing outside the window');
});

test('those hours hold on both sides of the UK clock change', () => {
  // British Summer Time ends on 25 October 2026. The India day must not move.
  for (const now of ['2026-10-01T06:00:00Z', '2026-11-05T06:00:00Z']) {
    const days = buildAvailability({
      rule: INDIA_RULE, taken: [], candidateTimezone: 'Asia/Kolkata', now: new Date(now),
    }).filter((d) => d.slots.length);
    assert.equal(days[0].slots[0].localTime ?? days[0].slots[0].label, '11:30', now);
  }
});

test('the other roles are offered exactly what the default rule says', () => {
  const days = DAYS(DEFAULT_RULE, 'Africa/Johannesburg').filter((d) => d.slots.length);
  assert.ok(days.length > 0);
  for (const day of days) {
    // 13:30 UK is 14:30 in Johannesburg while the UK is on summer time.
    const first = day.slots[0].localTime ?? day.slots[0].label;
    assert.ok(['14:30', '15:30'].includes(first), `first slot ${first}`);
    assert.equal(day.slots.length, 9, 'nine 20-minute slots in three hours');
  }
});

test('booking is checked against the same rule the slots came from', () => {
  const inside = new Date('2026-10-07T06:00:00Z'); // 11:30 IST
  const outside = new Date('2026-10-07T09:00:00Z'); // 14:30 IST, past 13:30
  const now = new Date('2026-10-01T06:00:00Z');
  assert.equal(isSlotBookable({ startsAt: inside.toISOString(), rule: INDIA_RULE, taken: [], now }).ok, true);
  assert.equal(isSlotBookable({ startsAt: outside.toISOString(), rule: INDIA_RULE, taken: [], now }).ok, false);
  // And that same instant is fine for a role on the default rule: 14:30 IST
  // is 10:00 UK... which is before 13:30, so it is not. Use one that is.
  const ukAfternoon = new Date('2026-10-07T12:30:00Z'); // 13:30 UK
  assert.equal(isSlotBookable({ startsAt: ukAfternoon.toISOString(), rule: DEFAULT_RULE, taken: [], now }).ok, true);
});

/* ── the migration itself ────────────────────────────────────────────────── */

const sql = (name) =>
  readFileSync(path.join(import.meta.dirname, '..', 'migrations', name), 'utf8');

test('recruit_018 is additive, and reversible', () => {
  const up = sql('recruit_018_role_hours.sql');
  const down = sql('recruit_018_role_hours_down.sql');

  assert.match(up, /ADD COLUMN IF NOT EXISTS role recruit_role;/, 'nullable, no default');
  assert.doesNotMatch(up, /ALTER TABLE recruit_interviews/, 'no interview is touched');
  assert.doesNotMatch(up, /DELETE FROM|DROP TABLE/, 'nothing is removed');
  // One default per interviewer, one row per role, enforced by the database.
  assert.match(up, /idx_recruit_rules_one_default[\s\S]*WHERE role IS NULL/);
  assert.match(up, /idx_recruit_rules_one_per_role[\s\S]*WHERE role IS NOT NULL/);
  // The India rows: their own zone, and no UK lunch inside a two-hour day.
  assert.match(up, /'Asia\/Kolkata'/);
  assert.match(up, /'11:30', '13:30'/);
  assert.match(up, /'\[\]'::jsonb/);
  assert.match(up, /india_intern[\s\S]*india_aidev/);
  assert.doesNotMatch(up, /sa_paralegal|sa_sales/, 'South Africa keeps the default');
  // Re-runnable.
  assert.match(up, /NOT EXISTS \(\s*SELECT 1 FROM recruit_availability_rules e/);

  for (const name of ['idx_recruit_rules_one_per_role', 'idx_recruit_rules_one_default', 'one_rule_per_interviewer']) {
    assert.match(down, new RegExp(name), `${name} handled on the way down`);
  }
  assert.match(down, /DROP COLUMN IF EXISTS role/);
});

test('every named object starts with recruit_ or idx_recruit_', () => {
  const up = sql('recruit_018_role_hours.sql');
  for (const [, name] of up.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS (\w+)/g)) {
    assert.match(name, /^idx_recruit_/, name);
  }
});

test('the calendar draws the default rule, and booking uses the candidate’s role', () => {
  const calendar = readFileSync(path.join(import.meta.dirname, 'calendar.js'), 'utf8');
  const booking = readFileSync(path.join(import.meta.dirname, '..', 'routes', 'booking.js'), 'utf8');
  const admin = readFileSync(path.join(import.meta.dirname, '..', 'routes', 'admin.js'), 'utf8');

  // One grid cannot be four sets of hours: it is the default's.
  assert.match(calendar, /pickRule\(ruleRows, null\)/);
  assert.doesNotMatch(calendar, /SELECT \* FROM recruit_availability_rules/);

  // The candidate's slots and the check when they book use the same rule.
  assert.equal((booking.match(/pickRule\(ruleRows, row\.role\)/g) || []).length, 2);

  // Settings edits the default rule only, and never a role's.
  assert.match(admin, /WHERE interviewer_id = \$1 AND to_jsonb\(recruit_availability_rules\) ->> 'role' IS NULL/);
  assert.match(admin, /ON r\.interviewer_id = i\.id AND to_jsonb\(r\) ->> 'role' IS NULL/);

  // The taken-slots query itself is never narrowed by role: one person, one
  // diary, so a slot another role has taken is gone for everyone.
  const takenSql = booking.match(/const TAKEN_FOR = `([\s\S]*?)`/)?.[1];
  assert.ok(takenSql, 'found the taken-slots query');
  assert.doesNotMatch(takenSql, /role/i);
});
