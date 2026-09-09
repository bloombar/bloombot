/**
 * Privacy policy, written from what this platform actually does rather than
 * from a template — what the Discord bot stores, what an instructor can read,
 * what leaves the box for the model provider, and what the cost ledger
 * records.
 *
 * **On what this deliberately does not promise.** It makes no commitment to
 * delete anything on request, to any retention window, or to honouring
 * statutory erasure rights, because the platform has no per-person deletion
 * path today: `packages/db`'s own schema carries a tenant-level deletion
 * (ADMIN-5) and nothing finer, transcripts are kept indefinitely, and no
 * scheduled sweep erases anything. A policy that promised otherwise would be
 * describing software nobody has written. Where a reader would expect such a
 * promise, this text says plainly that it cannot make one yet — that is the
 * honest version, and it is also the one that does not have to be walked back
 * later.
 *
 * **Google user data gets its own section** ("Google account data", below),
 * spelled out at the level of detail Google's own OAuth branding review asks
 * for (support.google.com/cloud/answer/13806988): what Google Sign-In gives
 * this service, that it is used only to identify and sign in an instructor,
 * and — explicitly — that it is never sold, never used for advertising or
 * profiling, never a factor in a credit decision, and never included in what
 * this service sends the model provider or otherwise uses to train an AI or
 * machine-learning model of any kind.
 */
import { OPERATOR, type StaticDocument } from './document.js'

export const privacyDocument: StaticDocument = {
  title: 'Privacy policy',
  summary:
    'What Bloombot records about instructors and students, why, and who can see it.',
  updated: '8 September 2026',
  body: `
Bloombot ("the service") is operated by ${OPERATOR.name} ("we", "us"). It
answers students' course questions on Discord and on the web, and gives
instructors a panel for the courses behind that. This policy explains what
personal data the service handles, who sees it, and — just as importantly —
what it does **not** yet let you do about it.

## What we record

**Instructor accounts.** Your email address and display name. Signing in is by
a link emailed to you, or with Google — in which case Google tells us your
email address, name and profile picture. We never see a password, because the
service has none.

**Student identities.** A student reaches the service through Discord or
through an emailed invitation, and we record what is needed to recognise them
again: a Discord account id and username, an email address where one was
supplied, and the courses they belong to. Instructors import rosters, so some
of this arrives from your institution rather than from the student.

**Conversations.** **Every question a student asks and every answer the
service gives is stored, in full, and kept.** That includes messages sent in
Discord and messages sent through the web chat, along with which course and
which channel they belong to, and when they were sent. This is the heart of
what the service holds, and it is the part worth reading twice: these are
students' own words, kept indefinitely.

**Course material.** Instructions, prompts and files instructors attach to a
course, which the service uses to answer questions.

**Usage and cost.** Token counts and a computed cost for each model call, so
that spending caps can be applied and an instructor can see what a course is
costing.

**Technical records.** Ordinary server logs — request paths, timestamps, error
traces — and an access log described below.

## Who can see a conversation

**An instructor can read their own students' conversations in full.** The
control panel has a transcripts screen for exactly this, with filtering by
student and by date, and an export. If you are a student using this service,
assume your instructor can read everything you asked it.

Two limits apply to that, and both are real:

- **Every transcript read and export is written to an access log** — who
  looked, at whose transcript, and when.
- That access log is itself readable only by an organization's owner, not by
  every instructor in it.

Platform administrators — a short, named list configured by the operator — can
reach an administration console covering organizations, their usage and the
platform's health. That console does not display any course, student or
message.

## AI processing

Answering a question means sending text to a model provider (OpenAI, in the
deployment this platform ships for). What is sent is the question itself, the
course's own instructions and attached material, and enough of the
conversation for the answer to make sense.

**A student's question is their own words, and it is sent as written.** We do
not strip names or other identifying details from it beforehand, because we
cannot reliably tell what inside a question is identifying. Anything a student
types is liable to reach the model provider, and their terms — not ours —
govern what they do with it in transit.

## Sharing

We do not sell this data, and we do not use it for advertising or behavioural
profiling. It leaves the service in exactly three directions: to the model
provider as described above, to Discord (because that is where the
conversation is happening), and to the mail relay that sends a sign-in link.

## Google account data

If you sign in with Google, this is the complete account of what that gives
us and what we do with it.

**What we receive.** Signing in with Google hands us your email address, your
name and your profile picture — nothing more. **We never receive a password**,
because Google's sign-in flow does not send us one; there is no password of
yours for this service to hold or to lose.

**What we use it for.** Only to create your instructor account the first time
you sign in, and to recognise you and sign you back in on every visit after
that. It plays no other role anywhere in the service.

**What we do not do with it.** Your Google account data is not sold, and it is
not shared with any third party beyond what the Sharing section above already
names. It is not used for advertising or profiling, and it is never a factor
in a credit decision. **It is never sent to the model provider, and it is
never used to train any AI or machine-learning model, generalized or
otherwise** — the "AI processing" section above describes exactly what does
reach the model provider (a question, a course's own material, and the
conversation around it), and your Google account data is not part of that and
never has been.

**Retention and deletion.** Like every other account record, your Google
account data is kept for as long as the service runs, under the same "How
long we keep it" rule below. Unlike a student's conversation, this one has a
concrete answer: write to ${OPERATOR.contactEmail} and ask that your
instructor account, or your whole organization, be deleted, and the operator
can act on it — the same tenant-level deletion this policy already describes
the platform as capable of. It removes your Google account data along with
everything else on the account.

## How long we keep it — and what we cannot yet offer

We keep conversations, accounts and usage records **for as long as the service
runs**. There is no retention window, no expiry, and no scheduled deletion.

**We do not currently offer a way to delete an individual student's data, and
this policy does not promise one.** The platform can delete a whole
organization's data, and an operator can do that on request; below that level
— one student, one conversation, one message — no deletion path exists in the
software today. We would rather say so than imply a right the service cannot
honour.

Depending on where you live, you may have statutory rights of access,
correction, portability or erasure. Those rights are not diminished by this
paragraph, and we are not claiming otherwise — but you should know that
satisfying an erasure request today would be a manual operation on a database,
not a feature. Write to ${OPERATOR.contactEmail} and we will tell you honestly
what we can and cannot do.

If any of this is unacceptable for your course, the right time to decide that
is before students start using the service.

## Security

Every connection to the service, including sign-in and every request the
Google sign-in flow makes, is encrypted in transit (HTTPS/TLS) — the operator
terminates TLS in front of the service, and it does not accept a plain,
unencrypted connection. Sign-in links are single-use bearer credentials,
stored hashed and short-lived. Session cookies are signed. Credentials the
service needs live in server-side configuration and are never sent to a
browser. Every request that reads or changes something checks that the
account making it is allowed to.

The service runs on a single server with a single database file, encrypted at
rest to the extent the underlying server disk is. Backups are the operator's
responsibility and their existence is a deployment choice, not a guarantee
this policy makes.

No system is perfectly secure, and we do not claim otherwise. This is an
actively developed platform, not a mature product.

## Children

The service is built for higher education and is not directed at children. We
do not knowingly create accounts for anyone under 16.

## Changes

We will update this page as the service changes, and the date above says when
it last changed. As the platform grows the deletion and retention behaviour
described here is expected to improve; this page will be updated when it does,
rather than in advance of it.

## Contact

${OPERATOR.name}
${OPERATOR.postalAddress ? `${OPERATOR.postalAddress}\n` : ''}${OPERATOR.contactEmail}
`.trim(),
}
