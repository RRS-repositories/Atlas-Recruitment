-- recruit_018 — booking hours per role.
--
-- Until now one rule row per interviewer decided every candidate's slots,
-- whatever they applied for. The India roles are to be interviewed 11:30-13:30
-- India time, while South Africa keeps the hours it has.
--
-- A rule row now carries an optional role. NULL means "the default": the row
-- that has always existed keeps working for every role that has no row of its
-- own, so a role nobody configures behaves exactly as it does today.
--
-- Everything here is additive. No interview is touched, no existing row
-- changes, and the engine that offers slots is unchanged -- it is handed a
-- rule, and this only decides which rule it is handed.

-- ── The role on a rule ──────────────────────────────────────────────────────
ALTER TABLE recruit_availability_rules
  ADD COLUMN IF NOT EXISTS role recruit_role;

COMMENT ON COLUMN recruit_availability_rules.role IS
  'The role these hours are for. NULL is the default, used by every role without its own row.';

-- One rule per interviewer becomes one DEFAULT rule per interviewer, plus at
-- most one per role. Two partial indexes rather than one over (interviewer_id,
-- role), because in a plain unique index NULLs are distinct -- which would
-- allow two defaults.
ALTER TABLE recruit_availability_rules
  DROP CONSTRAINT IF EXISTS one_rule_per_interviewer;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recruit_rules_one_default
  ON recruit_availability_rules (interviewer_id)
  WHERE role IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recruit_rules_one_per_role
  ON recruit_availability_rules (interviewer_id, role)
  WHERE role IS NOT NULL;

-- ── The India roles: 07:00-09:00 ────────────────────────────────────────────
--
-- In UK TIME, like every other hour on the Settings screen (decided 30 Sep).
-- That is 11:30-13:30 in India while the UK is on summer time, and
-- 12:30-14:30 once the clocks go back: the UK clock is the fixed one, and the
-- candidate's own time moves with it. Storing India time instead would fix
-- their clock and move ours, which is not how this screen reads.
--
-- Everything else -- slot length, buffer, notice, how far ahead, working days
-- and the lunch break -- is copied from the default rule, so those stay one
-- decision. The default lunch sits outside this window and so does nothing,
-- but it travels with the row in case the window is widened later.
--
-- Skipped for any role that already has a row, so re-running changes nothing.
INSERT INTO recruit_availability_rules (
  interviewer_id, role, timezone, weekdays, day_start, day_end,
  slot_minutes, buffer_minutes, min_notice_hours, max_days_ahead, blocks
)
SELECT r.interviewer_id, role_key, r.timezone, r.weekdays, '07:00', '09:00',
       r.slot_minutes, r.buffer_minutes, r.min_notice_hours, r.max_days_ahead, r.blocks
  FROM recruit_availability_rules r
 CROSS JOIN (VALUES ('india_intern'::recruit_role), ('india_aidev'::recruit_role)) AS v(role_key)
 WHERE r.role IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM recruit_availability_rules e
      WHERE e.interviewer_id = r.interviewer_id AND e.role = v.role_key
   );
