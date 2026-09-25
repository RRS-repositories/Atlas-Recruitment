import { registerTemplate } from '../lib/templates.js';
import { buildIcs } from '../lib/ics.js';
import { loadContext, publicBaseUrl, SIGN_OFF, joinLine, whenLine } from './context.js';
import { declineReapply, declineSentence } from '../../shared/declineReasons.js';
import { shell, p, greeting, callout, button, bodyBoth, esc } from './layout.js';
import { fill, loadSupplied } from './supplied.js';
import { REBOOK_EXPIRY_DAYS } from '../lib/rebookPolicy.js';

/**
 * Every email the portal sends.
 *
 * The four decision emails are the client's own words, copied from the
 * prototype (`ROLES.india.email`, `ROLES.sa.email`) rather than rewritten —
 * they have been read and approved, and improving someone's rejection letter
 * uninvited is not a favour. Two changes have since been asked for and made:
 * the India decline no longer claims a high volume of applications, and a
 * decline that names a reason the candidate can act on now carries an
 * invitation to apply again. The rest are drafted here and need
 * sign-off before they reach a real candidate.
 *
 * Each template is:
 *
 *   load()    live data, fetched when the email sends
 *   render()  a pure function of that data — testable, previewable
 *   sample    invented stand-in data for the manager's template screen. Never
 *             a real person: this is rendered on a page a browser can reach.
 */

const bookingUrl = (token) => `${publicBaseUrl()}/book/${token}`;

/**
 * The note beside the booking button.
 *
 * The supplied template says the interview takes place on Google Meet. It
 * does not: nothing creates a Meet link, and the calendar work we scoped is
 * Microsoft, because the firm runs on Microsoft 365. Naming a platform we do
 * not use would be discovered by the candidate on the day, so this says what
 * actually happens. The calendar file IS real -- the confirmation attaches an
 * .ics -- so that half of the sentence is kept.
 */
const MEETING_NOTE_TEXT =
  'The interview takes place on video. You will get a calendar file as soon as you book, the '
  + 'joining link before the day, and a reminder before it starts.';
const MEETING_NOTE_HTML =
  'The interview takes place on a <strong>video call</strong>. You&rsquo;ll get a calendar file '
  + 'as soon as you book, the joining link before the day, and a reminder before it starts.';

/** Every template shares the same live lookup; only the wording differs. */
const load = loadContext;

const SAMPLE = {
  firstName: 'Priya',
  fullName: 'Priya Example',
  email: 'priya@example.com',
  roleTitle: 'Paralegal Internship',
  roleCountry: 'India',
  interviewerName: 'Priyanshu Srivastava',
  interviewerFirstName: 'Priyanshu',
  interviewerEmail: 'interviewer@example.com',
  interviewerTimezone: 'Asia/Kolkata',
  interviewerDay: 'Tue 8 Sept',
  interviewerTime: '18:30',
  localDay: 'Tue 8 Sept',
  localTime: '18:30',
  ukTime: '14:00',
  timezone: 'Asia/Kolkata',
  startsAt: '2026-09-08T13:00:00.000Z',
  endsAt: '2026-09-08T13:30:00.000Z',
  meetLink: null,
  token: 'EXAMPLE-TOKEN-NOT-A-REAL-ONE',
};

// ── On submitting ───────────────────────────────────────────────────────────

registerTemplate({
  key: 'recruit.ack',
  title: 'Application received',
  when: 'Immediately after someone submits an application.',
  description:
    'Confirms we have it and sets the 48-hour expectation, so nobody is left wondering whether it arrived. Repeats the AI-use warning from the form, which is the last chance to say it before their answers are marked.',
  mergeFields: ['firstName', 'roleApplied'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: 'Fast Action Claims — we have your application',
    ...bodyBoth({
      heading: 'We have your application',
      preview: 'Thanks - we review every application ourselves, within 48 hours.',
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      `Thank you for applying for the ${data.roleApplied ?? data.roleTitle} at Fast Action Claims. Your application and CV have reached us safely.`,
      '',
      "We review every application ourselves rather than filtering them automatically, so please give us up to 48 hours. You'll hear from us either way — we don't leave people wondering.",
      '',
      'One reminder, because it matters: we use AI detection on every application. If your answers appear to have been written by ChatGPT or any other AI tool, your application will be discredited and will not be considered. We are looking for your own words, not polished ones.',
    
      ],
    }),
  }),
});

// ── Decisions — the client's own copy, unchanged ────────────────────────────

const acceptEmail = ({
  key,
  title,
  country,
  heading,
  opening,
  decision,
  timesNote,
  closing,
  // Optional, and only the Sales and AI Developer roles pass them. Left out,
  // they default to exactly what the four original decision emails have
  // always had. `interview` picks the India or South Africa sentence about
  // the interview; the India accept has always had the India one.
  description = `Wording and layout supplied by the client, in the ${country} template. Unchanged.`,
  sample = SAMPLE,
  interview = key === 'recruit.india.accept' ? 'india' : 'sa',
}) =>
  registerTemplate({
    key,
    title,
    audience: 'candidate',
    when: 'When a manager accepts an applicant. Carries their booking link.',
    description,
    mergeFields: ['firstName', 'token'],
    sample,
    load,
    render: (data) => {
      const link = bookingUrl(data.token);
      return {
        subject: `Fast Action Claims — ${heading}`,
        text: [
          `Dear ${data.firstName},`,
          '',
          opening,
          '',
          `${decision} The next step is a ${interview === 'india' ? 'short video interview' : 'video interview'} with ${data.interviewerName}, our Admin Manager, to discuss the role, your experience and ${interview === 'india' ? 'what to expect if you join our team' : 'the terms of the position'}.`,
          '',
          `Please choose a date and time that suits you using the link below — you'll only see slots that are still available${timesNote}:`,
          '',
          `▶ Book your interview: ${link}`,
          '',
          MEETING_NOTE_TEXT,
          '',
          closing,
          '',
          SIGN_OFF,
        ].join('\n'),
        html: shell({
          heading,
          preview: `Book your interview with ${data.interviewerName}, our Admin Manager.`,
          body: [
            greeting(data.firstName),
            p(esc(opening)),
            p(
              `${esc(decision)} The next step is a ${interview === 'india' ? 'short video interview' : 'video interview'} with ${esc(data.interviewerName)}, our Admin Manager, to discuss the role, your experience and ${interview === 'india' ? 'what to expect if you join our team' : 'the terms of the position'}.`,
            ),
            p(
              `Please choose a date and time that suits you using the button below &mdash; you'll only see slots that are still available${esc(timesNote)}.`,
            ),
            callout(MEETING_NOTE_HTML),
            button(link, 'Book your interview'),
          ].join('\n'),
        }),
      };
    },
  });

acceptEmail({
  key: 'recruit.india.accept',
  title: 'Shortlisted — India',
  country: 'India',
  heading: "You've been shortlisted",
  opening:
    'Thank you for applying for the Paralegal Internship at Fast Action Claims via Internshala.',
  decision: "We're delighted to let you know that your application has been successful.",
  timesNote: ', shown in your local time (IST)',
  closing: 'Congratulations, and we look forward to speaking with you soon.',
});

acceptEmail({
  key: 'recruit.sa.accept',
  title: 'Shortlisted — South Africa',
  country: 'South Africa',
  heading: 'Interview invitation',
  opening: 'Thank you for applying for the full-time Paralegal position at Fast Action Claims.',
  decision: "We're pleased to let you know that your application has been shortlisted.",
  timesNote: ', shown in your local time (SAST)',
  closing: 'We look forward to speaking with you.',
});

const DECLINE_MECHANICS =
  'The reason paragraph appears only when a manager chose one, and the invitation to apply again '
  + 'only for the reasons a candidate can act on. The preview below shows both.';

const declineEmail = ({
  key,
  title,
  country,
  opening,
  body,
  closing,
  // Optional, as for acceptEmail: only the Sales and AI Developer roles pass them.
  description = `Wording and layout supplied by the client, in the ${country} template. ${DECLINE_MECHANICS}`,
  sample = SAMPLE,
}) =>
  registerTemplate({
    key,
    title,
    when: 'When a manager declines an applicant.',
    description,
    mergeFields: ['firstName', 'declineSentence', 'declineReapply'],
    // The preview carries a reason and its invitation, because a template
    // screen that only ever shows the plainest version of an email is not
    // showing the manager what they are about to send.
    sample: {
      ...sample,
      declineSentence: declineSentence('answers_generic'),
      declineReapply: declineReapply('answers_generic'),
      reapplyUrl: publicBaseUrl(),
    },
    load,
    render: (data) => {
      // Said only when there is something to say. A manager who chose no
      // reason gave none, and the email must not invent one — so the
      // paragraph is absent rather than empty, and an email with no reason
      // reads exactly as it always has.
      const reason = data.declineSentence ? [data.declineSentence] : [];

      /*
       * The invitation to apply again.
       *
       * Only attached to a reason that carries one, and only when a reason was
       * given at all — see shared/declineReasons.js for which and why. It is
       * real rather than a courtesy: since recruit_012 the unique index is
       * partial, so a declined application genuinely does not block a new one,
       * and the link goes to the form they can fill in today.
       */
      const applyAgain = data.declineReapply || null;
      const applyUrl = data.reapplyUrl || publicBaseUrl();

      return {
        subject: 'Fast Action Claims — Application update',
        text: [
          `Dear ${data.firstName},`,
          '',
          opening,
          '',
          body,
          ...(reason.length ? [''] : []),
          ...reason,
          ...(applyAgain ? ['', applyAgain, '', `Apply again: ${applyUrl}`] : []),
          '',
          closing,
          '',
          SIGN_OFF,
        ].join('\n'),
        html: shell({
          heading: 'Application update',
          preview: 'An update on your application to Fast Action Claims.',
          body: [
            greeting(data.firstName),
            p(esc(opening)),
            p(esc(body)),
            ...reason.map((line) => p(esc(line))),
            ...(applyAgain ? [p(esc(applyAgain)), button(applyUrl, 'Apply again')] : []),
            p(esc(closing)),
          ].join('\n'),
        }),
      };
    },
  });

declineEmail({
  key: 'recruit.india.decline',
  title: 'Not successful — India',
  country: 'India',
  opening:
    'Thank you for taking the time to apply for the Paralegal Internship at Fast Action Claims via Internshala.',
  body: "After careful consideration, we've decided not to progress your application on this occasion. This doesn't reflect on your abilities.",
  closing: 'We appreciate your interest in our firm and wish you every success in your career.',
});

declineEmail({
  key: 'recruit.sa.decline',
  title: 'Not successful — South Africa',
  country: 'South Africa',
  opening:
    'Thank you for taking the time to apply for the full-time Paralegal position at Fast Action Claims.',
  body: "After careful consideration, we've decided not to take your application further on this occasion. We had a strong field of applicants and the decision was a close one.",
  closing: 'We appreciate your interest in the firm and wish you every success in your career.',
});

// ── Decisions — Sales & Customer Service (South Africa) ─────────────────────

/*
 * The South Africa template, word for word, with the role changed: the client
 * asked for the same wording and layout as the paralegal emails, only the
 * role different. Both are full-time permanent jobs, so "full-time" stays.
 *
 * The sample is its own invented Sales candidate, so the preview a manager
 * checks is the Sales email and not a paralegal one wearing its key.
 */
const SALES_SAMPLE = {
  ...SAMPLE,
  firstName: 'Thandi',
  fullName: 'Thandi Example',
  email: 'thandi@example.com',
  roleTitle: 'Sales & Customer Service',
  roleApplied: 'Sales & Customer Service position',
  roleCountry: 'South Africa',
  timezone: 'Africa/Johannesburg',
  localTime: '15:00',
};

acceptEmail({
  key: 'recruit.sales.accept',
  title: 'Shortlisted — Sales & Customer Service',
  country: 'South Africa',
  heading: 'Interview invitation',
  opening: 'Thank you for applying for the full-time Sales & Customer Service position at Fast Action Claims.',
  decision: "We're pleased to let you know that your application has been shortlisted.",
  timesNote: ', shown in your local time (SAST)',
  closing: 'We look forward to speaking with you.',
  description: 'Wording and layout supplied by the client, in the South Africa template, with the role changed to Sales & Customer Service.',
  sample: SALES_SAMPLE,
});

declineEmail({
  key: 'recruit.sales.decline',
  title: 'Not successful — Sales & Customer Service',
  country: 'South Africa',
  opening:
    'Thank you for taking the time to apply for the full-time Sales & Customer Service position at Fast Action Claims.',
  body: "After careful consideration, we've decided not to take your application further on this occasion. We had a strong field of applicants and the decision was a close one.",
  closing: 'We appreciate your interest in the firm and wish you every success in your career.',
  description: `Wording and layout supplied by the client, in the South Africa template, with the role changed to Sales & Customer Service. ${DECLINE_MECHANICS}`,
  sample: SALES_SAMPLE,
});

// ── Decisions — AI Developer (India) ────────────────────────────────────────

/*
 * The India template, word for word, with the role changed -- as the client
 * asked. One phrase dropped: "via Internshala". AI Developer candidates come
 * from LinkedIn, Naukri and elsewhere, so it would be untrue for most of them
 * (decided 18 Sep). The interview is the India one, "a short video interview"
 * about "what to expect if you join our team". Its own invented sample, so the
 * preview is this role's email.
 */
const AIDEV_SAMPLE = {
  ...SAMPLE,
  firstName: 'Arjun',
  fullName: 'Arjun Example',
  email: 'arjun@example.com',
  roleTitle: 'AI Developer',
  roleApplied: 'AI Developer position',
  roleCountry: 'India',
  timezone: 'Asia/Kolkata',
  localTime: '18:30',
};

acceptEmail({
  key: 'recruit.aidev.accept',
  title: 'Shortlisted — AI Developer',
  country: 'India',
  heading: "You've been shortlisted",
  opening: 'Thank you for applying for the AI Developer position at Fast Action Claims.',
  decision: "We're delighted to let you know that your application has been successful.",
  timesNote: ', shown in your local time (IST)',
  closing: 'Congratulations, and we look forward to speaking with you soon.',
  interview: 'india',
  description: 'Wording and layout supplied by the client, in the India template, with the role changed to AI Developer and "via Internshala" left out.',
  sample: AIDEV_SAMPLE,
});

declineEmail({
  key: 'recruit.aidev.decline',
  title: 'Not successful — AI Developer',
  country: 'India',
  opening:
    'Thank you for taking the time to apply for the AI Developer position at Fast Action Claims.',
  body: "After careful consideration, we've decided not to progress your application on this occasion. This doesn't reflect on your abilities.",
  closing: 'We appreciate your interest in our firm and wish you every success in your career.',
  description: `Wording and layout supplied by the client, in the India template, with the role changed to AI Developer and "via Internshala" left out. ${DECLINE_MECHANICS}`,
  sample: AIDEV_SAMPLE,
});

// ── Sarah's posts to the Mattermost interview channel ───────────────────────

/*
 * These two are not emails, and the differences are deliberate.
 *
 * The audience is the interviewer and the hiring manager, both in the channel,
 * so the time is given in the INTERVIEWER'S day rather than the candidate's.
 * For the India role those are the same zone; for South Africa they are not,
 * and a post telling somebody in Kolkata that an interview is at 10:00 SAST is
 * how a person joins an hour late.
 *
 * Nothing beyond name, role, time and link goes in. No score, no AI verdict,
 * no CV, no dashboard link. A chat channel is a permanent record with a wider
 * audience than the dashboard, and the dashboard already holds all of it
 * behind a login.
 *
 * `subject` is required by the registry and unused by a chat post; it is what
 * the templates preview screen shows, so it is written for a person anyway.
 */

/** The interviewer's own day and time, with UK alongside. */
const chatWhen = (data) =>
  data.interviewerDay && data.interviewerTime
    ? `${data.interviewerDay} at ${data.interviewerTime} (${data.ukTime} UK)`
    : 'a time still to be chosen';

registerTemplate({
  key: 'recruit.chat.booked',
  title: 'Mattermost — interview booked',
  audience: 'internal',
  when: 'Posted to the interview channel when a candidate books, and again if they move it.',
  description:
    'Goes to the Mattermost interview channel, not to anybody by email. Carries no score, no AI verdict and no CV — the dashboard holds those behind a login.',
  mergeFields: ['fullName', 'roleTitle', 'interviewerDay', 'interviewerTime', 'ukTime'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: `Interview booked — ${data.fullName}`,
    text: [
      `**Interview booked — ${data.fullName}**`,
      `${data.roleTitle} · ${chatWhen(data)}`,
      `Interviewer: ${data.interviewerName}`,
    ].join('\n'),
  }),
});

registerTemplate({
  key: 'recruit.chat.t10',
  title: 'Mattermost — ten minutes before',
  audience: 'internal',
  when: 'Posted to the interview channel ten minutes before an interview starts.',
  description:
    'The joining link, resolved at the moment it posts — so it is the current link for the current time even if the interview was moved after it was queued.',
  mergeFields: ['fullName', 'roleTitle', 'meetLink', 'interviewerTime', 'ukTime'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: `Interview in 10 minutes — ${data.fullName}`,
    text: [
      `**Interview in 10 minutes — ${data.fullName}**`,
      `${data.roleTitle} · ${chatWhen(data)}`,
      // Promising a link that does not exist is worse than saying so: whoever
      // reads this has ten minutes to find another way in, and only if we are
      // honest about it now.
      data.meetLink
        ? `Join: ${data.meetLink}`
        : 'No video link was created for this one — check the interview in the dashboard.',
    ].join('\n'),
  }),
});

// ── Booking ─────────────────────────────────────────────────────────────────

registerTemplate({
  key: 'recruit.booking.confirmed',
  title: 'Interview booked',
  when: 'When a candidate chooses their slot.',
  description:
    'Confirms the time in both zones and attaches a calendar file they can add to their own diary. Once stage 7 creates the Google event, this also carries the Meet link — no change needed here.',
  mergeFields: ['firstName', 'localDay', 'localTime', 'ukTime', 'interviewerName', 'meetLink', 'isFinalChance'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: `Your interview is booked — ${data.localDay} at ${data.localTime}`,
    ...bodyBoth({
      heading: 'Your interview is booked',
      preview: `${data.localDay} at ${data.localTime} - a calendar file is attached.`,
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      `Your interview with ${data.interviewerName} is booked for ${whenLine(data)}.`,
      '',
      // Only on a re-book offered after a no-show. Worded as the spec gives it,
      // and the ONLY difference from an ordinary confirmation -- the rest of
      // this email is untouched, so a first booking reads exactly as before.
      ...(data.isFinalChance
        ? ['This is your final scheduled interview. Please ensure you attend.', '']
        : []),
      'It lasts about 30 minutes and takes place on video.',
      '',
      joinLine(data),
      '',
      'A calendar file is attached so you can add it to your own diary.',
      '',
      'Need to change it? Use the same booking link we sent you — you can move it up to two hours beforehand.',
    
      ],
    }),
    attachments: data.startsAt
      ? [
          {
            filename: 'interview.ics',
            content: buildIcs({
              uid: `interview-${data.startsAt}@fastactionclaims.co.uk`,
              startsAt: data.startsAt,
              endsAt: data.endsAt,
              summary: `Interview — ${data.roleTitle} — Fast Action Claims`,
              description: `Interview with ${data.interviewerName}. ${joinLine(data)}`,
              location: data.meetLink ?? 'Video call — link to follow',
              organiserEmail: process.env.MAIL_FROM || 'recruitment@fastactionclaims.co.uk',
              attendeeEmail: data.email,
            }),
            contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
          },
        ]
      : [],
  }),
});

registerTemplate({
  key: 'recruit.rescheduled',
  title: 'Interview moved',
  when: 'When a candidate moves their interview to a different time.',
  description: 'Confirms the new time, so the old one cannot linger in their diary as the one they remember.',
  mergeFields: ['firstName', 'localDay', 'localTime', 'ukTime'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: `Your interview has moved — ${data.localDay} at ${data.localTime}`,
    ...bodyBoth({
      heading: 'Your interview has moved',
      preview: `Your new time is ${data.localDay} at ${data.localTime}.`,
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      `Your interview is now ${whenLine(data)}.`,
      '',
      'Please delete the earlier time from your diary if you added it.',
      '',
      joinLine(data),
    
      ],
    }),
  }),
});

/**
 * The only email in here addressed to us rather than to a candidate.
 *
 * It exists because a booking the interviewer never hears about is a booking
 * that does not happen. Times are given in their own zone first — that is the
 * day they are actually standing in — with the candidate's local time beside
 * it, so neither party is the one doing the arithmetic.
 */
registerTemplate({
  key: 'recruit.interviewer.booked',
  title: 'New interview in your diary',
  when: 'To the interviewer, when a candidate books or moves a slot.',
  description:
    'Sent to the interviewer rather than the candidate, so a booking cannot happen without them knowing. Carries the candidate’s name, role and address, the time in the interviewer’s own zone and the candidate’s, and a calendar file. Sent to the address on the Settings screen; if none is set, nothing is queued and the booking still succeeds.',
  mergeFields: ['interviewerFirstName', 'fullName', 'roleTitle', 'interviewerDay', 'interviewerTime', 'localTime', 'ukTime'],
  sample: { ...SAMPLE, moved: false },
  load,
  render: (data) => ({
    subject: data.moved
      ? `Interview moved — ${data.fullName} — ${data.interviewerDay} at ${data.interviewerTime}`
      : `New interview — ${data.fullName} — ${data.interviewerDay} at ${data.interviewerTime}`,
    ...bodyBoth({
      heading: data.guest ? 'An interview you are invited to' : 'New interview in your diary',
      preview: `${data.fullName} - ${data.interviewerDay} at ${data.interviewerTime}.`,
      signOff: SIGN_OFF,
      lines: [
      `Hi ${(data.guest ? '' : data.interviewerFirstName) || 'there'},`,
      '',
      // Two readers, one email. The interviewer's copy is what it always was;
      // `guest` is a person this role puts on its invites (Sales), for whom
      // the interview is neither "in your diary" nor booked "with you".
      data.guest
        ? data.moved
          ? `${data.fullName} has moved their interview with ${data.interviewerName}. You are invited to it.`
          : `${data.fullName} has booked an interview with ${data.interviewerName}. You are invited to it.`
        : data.moved
          ? `${data.fullName} has moved their interview.`
          : `${data.fullName} has booked an interview with you.`,
      '',
      `When:      ${data.interviewerDay} at ${data.interviewerTime} (${data.guest ? "the interviewer's time" : 'your time'})`,
      `           ${data.ukTime} UK time — ${data.localTime} for the candidate`,
      `Candidate: ${data.fullName} <${data.email}>`,
      `Role:      ${data.roleTitle}`,
      '',
      data.moved ? 'Please remove the earlier time from your diary.' : 'A calendar file is attached.',
      '',
      joinLine(data),
    
      ],
    }),
    attachments: data.startsAt
      ? [
          {
            filename: 'interview.ics',
            content: buildIcs({
              uid: `interviewer-${data.startsAt}@fastactionclaims.co.uk`,
              startsAt: data.startsAt,
              endsAt: data.endsAt,
              summary: `Interview — ${data.fullName} — ${data.roleTitle}`,
              description: `Candidate: ${data.fullName} <${data.email}>. ${joinLine(data)}`,
              location: data.meetLink ?? 'Video call — link to follow',
              organiserEmail: process.env.MAIL_FROM || 'recruitment@fastactionclaims.co.uk',
              attendeeEmail: data.interviewerEmail ?? undefined,
            }),
            contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
          },
        ]
      : [],
  }),
});

// ── The joining link, sent by hand ──────────────────────────────────────────

/**
 * Sent when somebody pastes the video link into the dashboard.
 *
 * Until the calendar integration creates meetings itself, this is how a
 * candidate gets a link at all. The link is SAVED on the interview as well as
 * emailed, which is the part that matters: every later email resolves its
 * merge fields at send time, so both reminders start carrying it too without
 * anybody sending a second thing.
 */
registerTemplate({
  key: 'recruit.meet.link',
  title: 'Your joining link',
  when: 'When a manager sends the video link from the dashboard.',
  description:
    'The link to join the interview, sent on its own. Saving it also means the 24-hour and 10-minute reminders carry it from then on, so this is normally sent once and never repeated.',
  mergeFields: ['firstName', 'localDay', 'localTime', 'ukTime', 'meetLink'],
  sample: { ...SAMPLE, meetLink: 'https://teams.microsoft.com/l/meetup-join/EXAMPLE' },
  load,
  render: (data) => ({
    subject: `Your interview link — ${data.localDay} at ${data.localTime}`,
    ...bodyBoth({
      heading: 'Your joining link',
      preview: 'The link to join your interview.',
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      `Here is the link for your interview with ${data.interviewerName}, ${whenLine(data)}.`,
      '',
      `Join the interview: ${data.meetLink}`,
      '',
      'It is worth opening the link a few minutes early the first time, in case your browser asks permission for the camera and microphone.',
      '',
      'If the link does not work on the day, reply to this email straight away.',
    
      ],
    }),
  }),
});

registerTemplate({
  key: 'recruit.cancelled',
  title: 'Interview cancelled',
  when: 'When a candidate cancels their interview.',
  description:
    'Acknowledges the cancellation and says how to come back, so someone who cancelled by accident is not stuck.',
  mergeFields: ['firstName'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: 'Your interview has been cancelled',
    ...bodyBoth({
      heading: 'Your interview has been cancelled',
      preview: 'Nothing further is needed from you.',
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      'We have cancelled your interview as requested. Nothing further is needed from you.',
      '',
      'If that was a mistake, or you would like to rebook, just reply to this email and we will send you a new link.',
    
      ],
    }),
  }),
});

/*
 * We cancelled, not them.
 *
 * An apology and a new booking link in the same email: a candidate told their
 * interview is off, with nothing to click, has to chase us for a time. The
 * link is a real new invitation, so the slot they choose books exactly as the
 * first one did.
 */
registerTemplate({
  key: 'recruit.cancelled.byus',
  title: 'We cancelled — please book again',
  audience: 'candidate',
  when: 'When a manager cancels an interview. Carries a new booking link.',
  description:
    'Apologises, says it is nothing to do with their application, and gives them a fresh link to choose another time.',
  mergeFields: ['firstName', 'token'],
  sample: SAMPLE,
  load,
  /*
   * Two shapes, one template. With a token the manager chose "cancel and send
   * a booking link", and the email asks them to pick a new time. Without one
   * they chose "cancel only": the same apology, no link, and a line saying we
   * will be in touch -- rather than a dead "book again" button, or silence.
   */
  render: (data) => {
    const rebook = Boolean(data.token);
    const link = rebook ? bookingUrl(data.token) : null;
    const APOLOGY =
      'We are sorry: we have had to cancel your interview with us. This is entirely on our side and says nothing about your application, which is still very much with us.';
    const NO_LINK_NEXT = 'We will be in touch shortly about arranging another time.';
    return {
      subject: rebook
        ? 'Your interview has been cancelled — please choose a new time'
        : 'Your interview has been cancelled',
      text: [
        `Dear ${data.firstName},`,
        '',
        APOLOGY,
        '',
        ...(rebook
          ? ['Please choose a new time that suits you using the link below:', '', `▶ Book a new time: ${link}`, '', MEETING_NOTE_TEXT]
          : [NO_LINK_NEXT]),
        '',
        'With our apologies for the inconvenience.',
        '',
        SIGN_OFF,
      ].join('\n'),
      html: shell({
        heading: 'Your interview has been cancelled',
        preview: rebook ? 'We are sorry — please choose a new time.' : 'We are sorry — we will be in touch.',
        body: [
          greeting(data.firstName),
          p(APOLOGY),
          ...(rebook
            ? [p('Please choose a new time that suits you using the button below.'), callout(MEETING_NOTE_HTML), button(link, 'Book a new time')]
            : [p(NO_LINK_NEXT)]),
          p('With our apologies for the inconvenience.'),
        ].join('\n'),
      }),
    };
  },
});

// ── Reminders ───────────────────────────────────────────────────────────────

registerTemplate({
  key: 'recruit.reminder.24h',
  title: 'Reminder — 24 hours before',
  when: 'Twenty-four hours before the interview starts.',
  description: 'Far enough ahead that someone who has a clash can still move it.',
  mergeFields: ['firstName', 'localDay', 'localTime', 'ukTime'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: `Your interview is tomorrow — ${data.localTime}`,
    ...bodyBoth({
      heading: 'Your interview is tomorrow',
      preview: `Tomorrow at ${data.localTime} - move it now if you cannot make it.`,
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      `A reminder that your interview with ${data.interviewerName} is ${whenLine(data)} — tomorrow.`,
      '',
      joinLine(data),
      '',
      'It helps to find a quiet spot with a steady connection, and to have a few questions ready.',
      '',
      'If you can no longer make it, please use your booking link to move it rather than leaving it — you can change it up to two hours beforehand.',
    
      ],
    }),
  }),
});

registerTemplate({
  key: 'recruit.reminder.10m',
  title: 'Reminder — 10 minutes before',
  when: 'Ten minutes before the interview starts.',
  description: 'The nudge that turns a booking into an attendance. Deliberately short — it is read on a phone.',
  mergeFields: ['firstName', 'localTime', 'meetLink'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: 'Your interview starts in 10 minutes',
    ...bodyBoth({
      heading: 'Your interview starts in 10 minutes',
      preview: `Starting at ${data.localTime}.`,
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      `Your interview with ${data.interviewerName} starts at ${data.localTime} — in about ten minutes.`,
      '',
      joinLine(data),
    
      ],
    }),
  }),
});

// ── Afterwards ──────────────────────────────────────────────────────────────

registerTemplate({
  key: 'recruit.noshow',
  title: 'We missed you',
  when: 'When a manager records that a candidate did not attend.',
  description:
    'Offers one rebook. Worded on the assumption something went wrong rather than that they could not be bothered — because usually something did.',
  mergeFields: ['firstName', 'token'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: 'We missed you — would you like to rebook?',
    ...bodyBoth({
      heading: 'We missed you',
      preview: 'Rebook whenever suits - your link is inside.',
      signOff: SIGN_OFF,
      lines: [
      `Hi ${data.firstName},`,
      '',
      `We were expecting you for your interview with ${data.interviewerName} and were not able to speak to you.`,
      '',
      'These things happen — a connection drops, a calendar goes wrong, a day gets away from you. If you would still like to be considered, you can pick a new time here:',
      '',
      `▶ Book a new time: ${bookingUrl(data.token)}`,
      '',
      'If we do not hear from you we will assume you would rather not go ahead, and we will close your application.',
    
      ],
    }),
  }),
});

// ── "Not attended" ─────────────────────────────────────────────────────────

/*
 * The final re-book email, used EXACTLY as supplied (decided 15 Sep) -- design
 * and wording both. The file lives, byte for byte, at
 * server/templates/supplied/email-noshow-rebook.html; supplied.js fills it in.
 */
const NOSHOW_REBOOK = loadSupplied('email-noshow-rebook.html');

/**
 * The supplied file's merge fields, from the live data.
 *
 * The queued row points at the MISSED interview (see notifyNoShowRebook), so
 * localDay / localTime / ukTime are the slot they missed, and `token` -- from
 * the row's vars -- is the NEW booking link.
 */
function noshowRebookValues(data) {
  // A re-book email without a working link is the one version worse than none.
  if (!data.token) throw new Error('recruit.noshow.rebook has no booking token to send');
  return {
    first_name: data.firstName,
    role_title: data.roleTitle,
    missed_time_local:
      data.localDay && data.localTime ? `${data.localTime} on ${data.localDay}` : 'your booked time',
    missed_time_uk: data.ukTime ?? '—',
    interviewer_name: data.interviewerName,
    booking_url: bookingUrl(data.token),
    expiry_days: String(REBOOK_EXPIRY_DAYS),
    // The opt-in "strong warning" paragraph (plan §6.4) is not built. Filled
    // with nothing, so the email reads exactly as supplied with it switched off.
    strong_warning: '',
  };
}

registerTemplate({
  key: 'recruit.noshow.rebook',
  title: 'Not attended — final re-book',
  when: 'When a manager marks a booked interview "Not attended" for the first time.',
  description:
    'Supplied as finished HTML and sent exactly as supplied. Offers one final re-book, valid for ' +
    `${REBOOK_EXPIRY_DAYS} days. Missing that interview, or not re-booking in time, closes the application.`,
  mergeFields: ['firstName', 'roleTitle', 'localDay', 'localTime', 'ukTime', 'interviewerName', 'token'],
  sample: SAMPLE,
  load,
  render: (data) => {
    const values = noshowRebookValues(data);
    return {
      subject: NOSHOW_REBOOK.subject,
      text: fill(NOSHOW_REBOOK.text, values),
      html: fill(NOSHOW_REBOOK.html, values, { html: true }),
    };
  },
});

/*
 * They missed the final chance too. No design or wording was supplied for this
 * one, so it is written in the shared layout, short and factual, and says what
 * the re-book email already told them would happen -- nothing more.
 *
 * DRAFT: needs approval on this screen before the switch goes on.
 */
registerTemplate({
  key: 'recruit.noshow.final',
  title: 'Not attended — application closed',
  when: 'When a manager marks a final-chance interview "Not attended".',
  description:
    'Approved 15 Sep. ' +
    'Short and factual: states the missed final interview and that the application is closed, as the re-book email said it would be. ' +
    'It is the only email sent: the ordinary decline email is not sent as well.',
  mergeFields: ['firstName', 'roleTitle', 'localDay', 'localTime', 'ukTime'],
  sample: SAMPLE,
  load,
  render: (data) => ({
    subject: 'Fast Action Claims — your application has been closed',
    ...bodyBoth({
      heading: 'Your application has been closed',
      preview: 'You did not attend your final interview.',
      signOff: SIGN_OFF,
      lines: [
        `Dear ${data.firstName},`,
        '',
        `You did not attend your final interview for the ${data.roleTitle}, booked for ${whenLine(data)}.`,
        '',
        'As we explained when we offered you a final opportunity to re-book, your application has now been closed, and you will not be considered for any future internship or role with Fast Action Claims, Rowan Rose Ltd, Beacon Legal Group or Atlas Recruitment.',
        '',
        'We will not contact you again about this application.',
      ],
    }),
  }),
});

/** Imported for its side effects; exported so a caller can assert it loaded. */
// Every registerTemplate() in this file. It had fallen behind (it read 11 while
// 17 were registered); templates.test.js now pins it to the registry.
export const TEMPLATE_COUNT = 22;
