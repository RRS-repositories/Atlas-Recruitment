import test from 'node:test';
import assert from 'node:assert/strict';

import { getTemplate } from '../lib/templates.js';
import { extendedRole } from '../lib/extendedRoles.js';
import './index.js';

/**
 * Who the Mattermost interview post names.
 *
 * Sales interviews are taken by the person that role puts on its own invites
 * (the address in RECRUIT_GOOGLE_SALES_EXTRA_GUESTS), so the channel names
 * them rather than the interviewer on the Settings screen. Every other role,
 * and any post queued before this existed, names the interviewer as always.
 */

const GUEST = 'sales.guest@example.com';

test('the post names the role’s own person when there is one', () => {
  const tpl = getTemplate('recruit.chat.booked');
  const sales = tpl.render({ ...tpl.sample, chatInterviewer: GUEST });
  const other = tpl.render({ ...tpl.sample, chatInterviewer: undefined });

  assert.match(sales.text, new RegExp(`Interviewer: ${GUEST}`));
  assert.match(other.text, new RegExp(`Interviewer: ${tpl.sample.interviewerName}`));
  // Nothing else about the post moves.
  assert.equal(sales.subject, other.subject);
  assert.equal(sales.text.split('\n').length, other.text.split('\n').length);
});

test('only Sales names one, and it comes from its own .env key', () => {
  assert.equal(extendedRole('sa_sales').calendar.extraGuestsEnv, 'RECRUIT_GOOGLE_SALES_EXTRA_GUESTS');
  assert.equal(extendedRole('india_aidev')?.calendar, undefined);
  assert.equal(extendedRole('india_intern'), null);
  assert.equal(extendedRole('sa_paralegal'), null);
});

test('the ten-minute post is untouched — it never named anybody', () => {
  const tpl = getTemplate('recruit.chat.t10');
  const out = tpl.render({ ...tpl.sample, chatInterviewer: GUEST });
  assert.doesNotMatch(out.text, /Interviewer:/);
  assert.doesNotMatch(out.text, new RegExp(GUEST));
});
