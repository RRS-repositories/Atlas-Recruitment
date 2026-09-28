import { enqueue, cancelPendingFor } from './outbox.js';
import { dedupeKey } from './outboxPolicy.js';
import { extendedRole } from './extendedRoles.js';
import { extraGuests } from './googleCalendar.js';

/**
 * Which email each event sends.
 *
 * One place, so the routes stay about what they do rather than what they
 * announce, and so the answer to "what does a candidate receive when X
 * happens" is readable in a single file.
 *
 * Every function here takes a transaction client. That is the whole point: the
 * email is queued in the same transaction as the thing that caused it, so a
 * decision cannot be recorded without its email, and no email goes out for a
 * decision that rolled back.
 */

const ACCEPT_TEMPLATE = {
  india_intern: 'recruit.india.accept',
  sa_paralegal: 'recruit.sa.accept',
  sa_sales: 'recruit.sales.accept',
  india_aidev: 'recruit.aidev.accept',
};
const DECLINE_TEMPLATE = {
  india_intern: 'recruit.india.decline',
  sa_paralegal: 'recruit.sa.decline',
  sa_sales: 'recruit.sales.decline',
  india_aidev: 'recruit.aidev.decline',
};

const HOUR = 3_600_000;

/** "Thanks, we have it." */
export const notifyApplicationReceived = (client, applicant) =>
  enqueue(client, {
    template: 'recruit.ack',
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    dedupeKey: dedupeKey('ack', applicant.id),
  });

/**
 * Accepted or declined.
 *
 * The booking token is passed through because it cannot be recovered: it is
 * returned by the accept transaction once and stored only as a hash. It is
 * also why the dedupe key includes it — reissuing a link is a deliberate
 * second send of this same email, with a different link inside.
 */
export function notifyDecision(client, { applicant, status, bookingToken = null }) {
  const template =
    status === 'accepted' ? ACCEPT_TEMPLATE[applicant.role] : DECLINE_TEMPLATE[applicant.role];
  if (!template) throw new Error(`no decision email for role ${applicant.role}`);

  return enqueue(client, {
    template,
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    vars: bookingToken ? { token: bookingToken } : {},
    dedupeKey: dedupeKey('decision', applicant.id, status, bookingToken?.slice(0, 12)),
  });
}

/**
 * A slot was chosen, or moved.
 *
 * Queues the confirmation and both reminders in one go. The reminders are just
 * rows with a future `send_after` — there is no scheduler to keep in step with
 * this, which is the reason the queue was built this way.
 *
 * Reminders are keyed on the START TIME as well as the interview, so moving an
 * interview produces genuinely new rows rather than colliding with the ones
 * for the old slot. The old ones are cancelled first.
 */
export async function notifyBooked(client, { applicant, interviewId, startsAt, isReschedule = false }) {
  const when = new Date(startsAt);

  // Anything still queued for the previous time is now wrong. Cancelled, not
  // deleted, so the record of what was planned survives.
  if (isReschedule) await cancelPendingFor(client, interviewId, 'interview moved');

  const common = {
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    interviewId,
  };

  await enqueue(client, {
    ...common,
    template: isReschedule ? 'recruit.rescheduled' : 'recruit.booking.confirmed',
    dedupeKey: dedupeKey(isReschedule ? 'moved' : 'confirmed', interviewId, when),
  });

  // A reminder is only worth sending while there is still time to act on it.
  // Booking is at least 24 hours ahead, so this normally lands; a reschedule
  // into tomorrow morning can legitimately leave no room for it.
  const dayBefore = new Date(when.getTime() - 24 * HOUR);
  if (dayBefore.getTime() - Date.now() > HOUR) {
    await enqueue(client, {
      ...common,
      template: 'recruit.reminder.24h',
      sendAfter: dayBefore,
      dedupeKey: dedupeKey('reminder24', interviewId, when),
    });
  }

  const tenBefore = new Date(when.getTime() - 10 * 60_000);
  if (tenBefore.getTime() > Date.now()) {
    await enqueue(client, {
      ...common,
      template: 'recruit.reminder.10m',
      sendAfter: tenBefore,
      dedupeKey: dedupeKey('reminder10', interviewId, when),
    });
  }

  await notifyInterviewer(client, { applicant, interviewId, when, moved: isReschedule });
}

/**
 * Tells the interviewer, at the address on the Settings screen.
 *
 * A booking nobody told the interviewer about is a booking that does not
 * happen, so this goes out on a move as well as a first booking — a stale
 * time in their diary is the same failure as no time at all.
 *
 * Deliberately best-effort. If no address is configured there is nothing to
 * send and the candidate's booking must still succeed: the interviewer not
 * being told is a worse outcome than nothing, but a candidate unable to book
 * at all is worse still.
 */
/**
 * The people a role puts on its interviews' Meet invites (sales/role.js ->
 * RECRUIT_GOOGLE_SALES_EXTRA_GUESTS). Empty for every other role.
 *
 * They are on the Google event, which is what lets them join without
 * knocking -- but the portal tells Google to send no invitations at all
 * (`sendUpdates: 'none'`, so a candidate hears about their interview once,
 * from us). Nobody was therefore telling these guests anything: no email when
 * a candidate books, none when they move it, and an event their calendar may
 * never show them. So they get the interviewer's email too.
 */
const roleGuestsFor = (role) => {
  const key = extendedRole(role)?.calendar?.extraGuestsEnv;
  return key ? extraGuests(process.env, key) : [];
};

async function notifyInterviewer(client, { applicant, interviewId, when, moved }) {
  const { rows } = await client.query(
    `SELECT iv.email
       FROM recruit_interviews i
       JOIN recruit_interviewers iv ON iv.id = i.interviewer_id
      WHERE i.id = $1 AND iv.active`,
    [interviewId],
  );

  const to = rows[0]?.email;
  if (!to) {
    console.warn('[fac-recruit] no interviewer address configured — nobody told about the booking');
    return;
  }

  await enqueue(client, {
    template: 'recruit.interviewer.booked',
    toEmail: to,
    applicantId: applicant.id,
    interviewId,
    // `moved` is not something the live lookup knows, so it is frozen here.
    // Everything else is resolved at send time as usual.
    vars: { moved },
    dedupeKey: dedupeKey(moved ? 'iv-moved' : 'iv-booked', interviewId, when),
  });

  /*
   * The same two facts, and the same calendar file, to this role's guests.
   * `guest` changes the wording: it is not their diary the interview is in,
   * and nobody booked it "with them". One row each, keyed per address, so a
   * second guest added later does not rob the first of their email.
   */
  for (const guest of roleGuestsFor(applicant.role)) {
    if (guest === String(to).toLowerCase()) continue;
    await enqueue(client, {
      template: 'recruit.interviewer.booked',
      toEmail: guest,
      applicantId: applicant.id,
      interviewId,
      vars: { moved, guest: true },
      dedupeKey: dedupeKey(moved ? 'guest-moved' : 'guest-booked', interviewId, guest, when),
    });
  }

  /*
   * The same two facts, in the Mattermost interview channel.
   *
   * Queued here rather than anywhere else because this function has already
   * done the work of finding an active interviewer, and because everything the
   * queue gives an email it gives these for nothing: exactly-once through the
   * dedupe key, retry with backoff, and cancellation when the interview moves
   * -- `cancelPendingFor` does not care what channel a row is on.
   *
   * `toEmail` is the interviewer's address on both. A chat post has no
   * recipient address of its own, and this keeps the row honest about who it
   * concerns, so the applicant's delivery history still reads properly.
   *
   * Queued even when Mattermost is not configured. The drain cancels those
   * with a reason rather than retrying, and the day the env values are added
   * the feature starts working with no deploy and no change here.
   */
  await enqueue(client, {
    channel: 'mattermost',
    template: 'recruit.chat.booked',
    toEmail: to,
    applicantId: applicant.id,
    interviewId,
    dedupeKey: dedupeKey(moved ? 'chat-moved' : 'chat-booked', interviewId, when),
  });

  // Ten minutes before, alongside the candidate's own reminder. Only if that
  // is still in the future -- a booking made five minutes before the slot
  // would otherwise queue a post that is already late.
  const tenBefore = new Date(when.getTime() - 10 * 60_000);
  if (tenBefore.getTime() > Date.now()) {
    await enqueue(client, {
      channel: 'mattermost',
      template: 'recruit.chat.t10',
      toEmail: to,
      applicantId: applicant.id,
      interviewId,
      sendAfter: tenBefore,
      dedupeKey: dedupeKey('chat10', interviewId, when),
    });
  }
}

/**
 * The video link, sent by hand from the dashboard.
 *
 * The caller has already saved it on the interview, which is the half that
 * keeps working after this email: every template resolves its merge fields at
 * send time, so both reminders pick the link up from then on.
 *
 * Keyed to the minute rather than the millisecond. A double-click cannot send
 * two identical emails, but somebody deliberately resending later - because a
 * candidate says it never arrived, or the link changed - still gets through.
 */
export const notifyMeetingLink = (client, { applicant, interviewId }) =>
  enqueue(client, {
    template: 'recruit.meet.link',
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    interviewId,
    dedupeKey: dedupeKey('meetlink', interviewId, Math.floor(Date.now() / 60_000)),
  });

/**
 * Cancelled by US, with a new link so they can pick another time.
 *
 * Separate from notifyCancelled (the candidate's own cancellation): that one
 * says "as requested" and needs no link, which would be a strange thing to
 * send someone whose interview WE called off. The pending reminders are
 * cancelled for the interview that is not happening; the email is attached to
 * the new one, whose token it carries.
 */
export async function notifyCancelledByUs(client, { applicant, cancelledInterviewId, interviewId, bookingToken }) {
  await cancelPendingFor(client, cancelledInterviewId, 'interview cancelled by us');

  return enqueue(client, {
    template: 'recruit.cancelled.byus',
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    interviewId,
    vars: bookingToken ? { token: bookingToken } : {},
    dedupeKey: dedupeKey('cancelledbyus', cancelledInterviewId, Date.now()),
  });
}

/** Cancelled by the candidate. Their reminders must not still arrive. */
export async function notifyCancelled(client, { applicant, interviewId }) {
  await cancelPendingFor(client, interviewId, 'interview cancelled');

  return enqueue(client, {
    template: 'recruit.cancelled',
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    interviewId,
    dedupeKey: dedupeKey('cancelled', interviewId, Date.now()),
  });
}

/**
 * They did not turn up.
 *
 * Carries a fresh booking link, because the offer is worth nothing without
 * one. Keyed on the interview alone, so marking someone a no-show twice — or
 * correcting to attended and back — cannot send this a second time.
 */
export const notifyNoShow = (client, { applicant, interviewId, bookingToken }) =>
  enqueue(client, {
    template: 'recruit.noshow',
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    interviewId,
    vars: { token: bookingToken },
    dedupeKey: dedupeKey('noshow', interviewId),
  });

/**
 * "Not attended" -- the firm, final re-book email (recruit.noshow.rebook).
 *
 * The row points at the MISSED interview, not the new one. The email names the
 * time they missed ("{{interviewer_name}} was waiting for you at ..."), and the
 * live lookup resolves times from the interview on the row -- the new re-book
 * interview has no time yet, so pointing there would print "a time still to be
 * chosen" where the missed slot belongs. The new booking token travels in
 * `vars`, exactly as `notifyNoShow` carries its token.
 *
 * Must be queued AFTER `cancelPendingFor(missedInterviewId)`, which calls off
 * the missed interview's remaining reminders. Queued before it, this email
 * would be the first thing cancelled.
 *
 * Keyed on the missed interview alone: however the press is retried, one
 * missed interview produces one of these.
 */
export const notifyNoShowRebook = (client, { applicant, missedInterviewId, bookingToken }) =>
  enqueue(client, {
    template: 'recruit.noshow.rebook',
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    interviewId: missedInterviewId,
    vars: { token: bookingToken },
    dedupeKey: dedupeKey('noshow-rebook', missedInterviewId),
  });

/**
 * They missed the final chance too (recruit.noshow.final).
 *
 * This is the ONLY email a final no-show sends. The ordinary decline email is
 * deliberately not queued alongside it: two emails about one ending, saying it
 * two different ways, is worse than either.
 */
export const notifyNoShowFinal = (client, { applicant, interviewId }) =>
  enqueue(client, {
    template: 'recruit.noshow.final',
    toEmail: applicant.email,
    toName: applicant.full_name,
    applicantId: applicant.id,
    interviewId,
    dedupeKey: dedupeKey('noshow-final', interviewId),
  });
