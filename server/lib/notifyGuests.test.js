import test from 'node:test';
import assert from 'node:assert/strict';

import { notifyBooked } from './notify.js';
import { getTemplate } from './templates.js';
import '../templates/index.js';

/**
 * The people a role puts on its interviews' Meet invites (Sales) are told
 * when a candidate books and when they move it.
 *
 * They were on the Google event from the start -- that is what lets them join
 * without knocking -- but the portal tells Google to send no invitations at
 * all, so nothing ever reached them. Pinned here: Sales interviews queue the
 * email, every other role queues exactly what it always did, and the guest's
 * copy does not read as though the interview were in their own diary.
 */

const GUEST = 'sales.guest@example.com';
const INTERVIEWER = 'interviewer@example.com';

/** A client that records what was queued, and answers the interviewer lookup. */
function fakeClient() {
  const queued = [];
  return {
    queued,
    query: async (sql, params) => {
      if (/recruit_interviewers/.test(sql)) return { rows: [{ email: INTERVIEWER }] };
      if (/INSERT INTO recruit_outbox/.test(sql)) {
        // (template, to_email, to_name, applicant_id, interview_id, vars, send_after, dedupe_key, channel)
        queued.push({ template: params[0], to: params[1], vars: params[5], dedupe: params[7], channel: params[8] });
        return { rows: [{ id: 'row' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const booked = async (role, { isReschedule = false, guests = GUEST } = {}) => {
  const had = process.env.RECRUIT_GOOGLE_SALES_EXTRA_GUESTS;
  if (guests === null) delete process.env.RECRUIT_GOOGLE_SALES_EXTRA_GUESTS;
  else process.env.RECRUIT_GOOGLE_SALES_EXTRA_GUESTS = guests;
  const client = fakeClient();
  try {
    await notifyBooked(client, {
      applicant: { id: 'a1', email: 'candidate@example.com', full_name: 'Test Candidate', role },
      interviewId: 'i1',
      startsAt: new Date(Date.now() + 5 * 86_400_000),
      isReschedule,
    });
  } finally {
    if (had === undefined) delete process.env.RECRUIT_GOOGLE_SALES_EXTRA_GUESTS;
    else process.env.RECRUIT_GOOGLE_SALES_EXTRA_GUESTS = had;
  }
  return client.queued;
};

const toGuest = (queued) => queued.filter((q) => q.to === GUEST);

test('a Sales booking tells the guest, as well as everyone it always told', async () => {
  const queued = await booked('sa_sales');
  const guestRows = toGuest(queued);
  assert.equal(guestRows.length, 1);
  assert.equal(guestRows[0].template, 'recruit.interviewer.booked');
  assert.equal(JSON.parse(guestRows[0].vars).guest, true);
  // The interviewer's own email is still there, exactly once, unchanged.
  const interviewerRows = queued.filter((q) => q.to === INTERVIEWER && q.template === 'recruit.interviewer.booked');
  assert.equal(interviewerRows.length, 1);
  assert.equal(JSON.parse(interviewerRows[0].vars).guest, undefined);
});

test('moving a Sales interview tells the guest too, under a different key', async () => {
  const bookedRows = toGuest(await booked('sa_sales'));
  const movedRows = toGuest(await booked('sa_sales', { isReschedule: true }));
  assert.equal(movedRows.length, 1);
  assert.equal(JSON.parse(movedRows[0].vars).moved, true);
  assert.notEqual(movedRows[0].dedupe, bookedRows[0].dedupe, 'a move is not deduped against the booking');
});

test('every other role queues exactly what it did before', async () => {
  for (const role of ['india_intern', 'sa_paralegal', 'india_aidev']) {
    const queued = await booked(role);
    assert.deepEqual(toGuest(queued), [], role);
    assert.deepEqual(
      [...new Set(queued.map((q) => q.to))].sort(),
      ['candidate@example.com', INTERVIEWER].sort(),
      `${role}: only the candidate and the interviewer are written to`,
    );
  }
});

test('no guest configured, or the guest IS the interviewer: nothing extra', async () => {
  assert.deepEqual(toGuest(await booked('sa_sales', { guests: null })), []);
  assert.deepEqual(toGuest(await booked('sa_sales', { guests: '' })), []);
  const same = await booked('sa_sales', { guests: INTERVIEWER });
  assert.equal(same.filter((q) => q.to === INTERVIEWER && q.template === 'recruit.interviewer.booked').length, 1);
});

test("the guest's copy does not claim the interview is in their diary", () => {
  const tpl = getTemplate('recruit.interviewer.booked');
  const guest = tpl.render({ ...tpl.sample, guest: true });
  const interviewer = tpl.render({ ...tpl.sample, guest: false });

  assert.match(guest.text, /You are invited to it\./);
  assert.doesNotMatch(guest.text, /booked an interview with you/);
  assert.doesNotMatch(guest.html, /New interview in your diary/);
  assert.match(guest.text, /Hi there,/);
  // Same facts, same calendar file, same subject.
  assert.equal(guest.subject, interviewer.subject);
  assert.equal(guest.attachments?.[0]?.filename, 'interview.ics');
  for (const part of [tpl.sample.fullName, tpl.sample.roleTitle, tpl.sample.interviewerTime]) {
    assert.ok(guest.text.includes(part), String(part));
  }
  // And the interviewer's copy is untouched.
  assert.match(interviewer.text, /has booked an interview with you\./);
  assert.match(interviewer.html, /New interview in your diary/);
});
