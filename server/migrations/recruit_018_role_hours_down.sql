-- Undo recruit_018 — back to one rule for every role.
--
-- Destructive in one direction only: the per-role rows are deleted, so any
-- hours set for a role are lost. The default rule -- the one every role used
-- before this migration -- is untouched, so booking keeps working throughout.

DELETE FROM recruit_availability_rules WHERE role IS NOT NULL;

DROP INDEX IF EXISTS idx_recruit_rules_one_per_role;
DROP INDEX IF EXISTS idx_recruit_rules_one_default;

ALTER TABLE recruit_availability_rules
  DROP COLUMN IF EXISTS role;

-- The constraint this migration replaced. Added back only if it is gone, and
-- only when the rows allow it -- which they do, the per-role ones having just
-- been deleted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'one_rule_per_interviewer'
       AND conrelid = 'recruit_availability_rules'::regclass
  ) THEN
    ALTER TABLE recruit_availability_rules
      ADD CONSTRAINT one_rule_per_interviewer UNIQUE (interviewer_id);
  END IF;
END $$;
