/**
 * Which booking rule a candidate's slots come from.
 *
 * A rule row now carries an optional role (recruit_018). The row with no role
 * is the default and has always existed; a role with a row of its own uses it
 * instead. Nothing else about availability changes: the engine is handed a
 * rule and works exactly as it did -- this only decides which one.
 *
 * Written so a database WITHOUT recruit_018 still works: `role` is read
 * through to_jsonb rather than by name, and a server that finds no per-role
 * row falls back to the default, which is every role's rule today.
 */

/**
 * Every rule for one interviewer, the role-specific ones first.
 *
 * $1 interviewer id. One round trip, so the booking path keeps the shape it
 * had: `pickRule` below does the choosing, and is pure.
 */
export const RULES_FOR_INTERVIEWER = `
  SELECT r.*, to_jsonb(r) ->> 'role' AS rule_role
    FROM recruit_availability_rules r
   WHERE r.interviewer_id = $1
`;

/**
 * The rule that applies to `role`: its own if it has one, otherwise the
 * default. Null when the interviewer has no rules at all, which the caller
 * already treats as "no availability is configured".
 */
export function pickRule(rows, role) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const mine = role ? rows.find((r) => r.rule_role === role) : null;
  // A row whose role is NULL. Also the only row on a database that has not
  // had recruit_018, where `rule_role` is undefined for every row.
  const fallback = rows.find((r) => !r.rule_role) ?? null;
  return mine ?? fallback;
}
