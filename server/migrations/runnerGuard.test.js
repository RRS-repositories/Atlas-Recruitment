import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every recruitment migration must survive the CRM's runner.
 *
 * The portal's migrations are applied inside the CRM, by
 * routes/recruit/apply-recruit-migrations.mjs, which refuses any file that
 * names something outside the recruitment module -- the database is shared
 * with the CRM's own tables, and a migration that reached them would be
 * discovered at the worst moment.
 *
 * Its reading is textual, and one of its blind spots cost a deploy: it treats
 * `ON <word>` as naming an object unless the word is one it knows, and
 * `COLUMN` is not one of them -- so `COMMENT ON COLUMN recruit_x.y` reads as
 * recruitment reaching outside itself and the file is refused. The rules are
 * repeated here so that is caught while the migration is being written, not
 * while a production deploy is half done.
 *
 * Kept in step with the runner by hand. If the runner's lists change, change
 * these; a mismatch here shows up as a migration that passes and is refused.
 */

const DIR = import.meta.dirname;

/** Its keyword lists, verbatim. */
const ON_TAKES_NAME = new Set(['sequence', 'table', 'function', 'type', 'domain', 'database']);
const ON_IS_SYNTAX = new Set(['conflict', 'delete', 'update', 'true', 'commit', 'all', 'schema']);
const NAMED =
  /\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|TYPE|FUNCTION|TRIGGER|VIEW|SEQUENCE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][\w.]*)/gi;

const isRecruitName = (name) => /^(recruit_|idx_recruit_)/.test(name);
const plain = (name) => name.toLowerCase().replace(/^public\./, '');

/** The offenders the runner would report for one file. */
function offenders(sql) {
  const stripped = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const found = [];
  for (const match of stripped.matchAll(NAMED)) {
    if (!isRecruitName(plain(match[2]))) found.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  for (const match of stripped.matchAll(/\bON\s+([A-Za-z_][\w.]*)(?:\s+([A-Za-z_][\w.]*))?/gi)) {
    let name = plain(match[1]);
    if (ON_IS_SYNTAX.has(name)) continue;
    if (ON_TAKES_NAME.has(name)) {
      if (!match[2]) continue;
      name = plain(match[2]);
    }
    if (!isRecruitName(name)) found.push(`ON ${name}`);
  }
  return [...new Set(found)];
}

/*
 * Only the files the runner will ever read.
 *
 * It skips migrations already recorded as applied, and everything before
 * recruit_016 was applied before it existed -- several of those carry prose
 * inside COMMENT strings ("...based on this...") that this reading would flag
 * and that no longer matters. New migrations are what this protects.
 */
const FIRST_CHECKED = 'recruit_016';
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql') && f >= FIRST_CHECKED)
  .sort();

test('there are migrations to check', () => {
  assert.ok(files.length >= 6, `${files.length} migration files from ${FIRST_CHECKED} on`);
});

for (const file of files) {
  test(`${file} names nothing outside the recruitment module`, () => {
    const sql = readFileSync(path.join(DIR, file), 'utf8');
    assert.deepEqual(offenders(sql), [], 'the CRM runner would refuse this file');
  });
}

test('the blind spot that caused it: COMMENT ON COLUMN is refused', () => {
  // Not a rule anyone would guess, so it is spelled out: this is refused even
  // though the column is a recruit_ one.
  assert.deepEqual(
    offenders("COMMENT ON COLUMN recruit_availability_rules.role IS 'x';"),
    ['ON column'],
  );
  // While the forms the runner does understand are accepted.
  assert.deepEqual(offenders('CREATE INDEX idx_recruit_x ON recruit_y (z);'), []);
  assert.deepEqual(offenders('ALTER TABLE recruit_y ADD COLUMN z text;'), []);
  assert.deepEqual(offenders("INSERT INTO recruit_y VALUES (1) ON CONFLICT DO NOTHING;"), []);
  // And a migration that really did reach a CRM table is still caught.
  assert.deepEqual(offenders('ALTER TABLE contacts ADD COLUMN z text;'), ['TABLE contacts']);
  assert.deepEqual(offenders('CREATE INDEX idx_recruit_x ON contacts (z);'), ['ON contacts']);
});
