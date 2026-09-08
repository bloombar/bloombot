/**
 * Terms & conditions, written against what the platform actually does —
 * per-course spending caps (COST-3), request limits (`maxRequestsPerDay`),
 * instructor transcript access (ADMIN-1..3), the Discord install flow — rather
 * than from a template.
 *
 * Like the privacy policy it deliberately withholds the promises the software
 * cannot keep: no availability commitment, no deletion right, and an explicit
 * statement that this is a pilot. See `privacy.ts`'s own module comment for
 * why that is the honest form rather than a gap to be filled in later.
 */
import { draftNotice, OPERATOR, type StaticDocument } from './document.js'

export const termsDocument: StaticDocument = {
  title: 'Terms & conditions',
  summary: 'The agreement between you and us for using Bloombot.',
  updated: '8 September 2026',
  body: `
${draftNotice(OPERATOR)}

These terms are an agreement between you and ${OPERATOR.name} ("we", "us")
covering your use of Bloombot ("the service"). By creating an account, joining
a course, or asking the service a question you accept them. If you are using it
on behalf of an institution, you confirm you may bind that institution.

## What this service is

Bloombot answers students' questions about a course, on Discord and on the web,
using material an instructor supplies. It is **actively developed software run
as a teaching pilot**, not a finished product. Read the availability section
below before you depend on it for a class.

## Accounts

Instructors need an account. Sign-in is by emailed link or with Google — there
is no password to choose or lose. Keep access to your mailbox to yourself: a
sign-in link is a credential, and anyone holding one can act as you until it is
used or expires.

Students reach the service through Discord or an emailed invitation and do not
choose their own account; an instructor's roster import creates it.

You must be old enough to enter a contract where you live, and at least 16.

## What you may use it for

Use the service for teaching, learning and the ordinary work around them. Do
not use it to:

- break the law, or infringe anyone's copyright, privacy or confidentiality;
- upload course material you have no right to redistribute;
- harass, defame or target anyone;
- attack, probe, overload or circumvent the limits of the service, scrape it,
  or resell access to it;
- attempt to make the model produce content any of the above would cover.

We can remove content and suspend accounts that do these things.

## Instructors: what you are taking on

Running a course on this service means you decide what students' conversations
are used for, and it means:

- **You can read your students' conversations in full**, and each time you do
  it is logged. Tell your students that before they start using it — do not
  leave them to discover it.
- **Their questions are sent to a third-party model provider as written**, and
  are not de-identified first. If your institution's rules or your students'
  expectations do not allow that, this service is not suitable for your course.
- **You are responsible for the material you attach** to a course and for
  having the rights to it.
- **Conversations are kept indefinitely, and cannot be deleted per student.**
  See the [Privacy policy](/privacy). Agreeing to these terms means accepting
  that as it stands today.

## AI-generated content

Answers are produced by a statistical model. **They are frequently wrong.**
The model can invent facts, misstate a deadline, misread your course material,
and answer confidently either way. Nothing it produces should be relied on
without checking, and it must not be treated as authoritative about a
syllabus, a grade or a policy. We make no warranty as to accuracy,
originality, or fitness for any purpose.

## Your content

You keep ownership of what you create and upload. To run the service we need
permission to do the obvious things with it: store it, process it, transmit it
to the model and infrastructure providers the service is built on, and render
it back to you and to the students in the relevant course.

## Third-party services

The service depends on others — a model provider, Discord, a mail relay. Their
terms apply to their parts, we do not control them, and an interruption at any
of them interrupts the feature that uses it.

## Cost controls

Model usage costs money, and the service meters it: each course has a spending
cap and a daily request limit. **When a cap is reached, the service stops
answering for that course** until the period resets or the cap is raised. That
is the intended behaviour, not a fault.

Recorded costs are computed from published provider rates and are an estimate
for your own budgeting. They are not a bill, and they are not guaranteed to
match what the provider actually charges the operator.

## Availability

The service is offered as it is and as it is available. **We do not promise any
level of availability.** It runs on a single server; there will be downtime,
defects, and mistakes that affect data. Do not make it the only route by which
students can reach you, and do not rely on it during an assessment.

## Ending the agreement

You may stop using the service at any time. We may suspend or end access that
breaks these terms, that we are legally required to act on, or — with
reasonable notice — if we discontinue the service. What happens to stored data
afterwards is described in the [Privacy policy](/privacy), including its
current limits.

## Liability

To the fullest extent the law allows, we are not liable for indirect,
incidental or consequential losses, for lost profits, or for lost or
inaccurate content — including anything the model generated. Where liability
cannot be excluded, it is limited to the amount you paid us in the twelve
months before the claim. Nothing here limits liability that cannot lawfully be
limited.

You agree to cover us against claims arising from material you uploaded or
published in breach of these terms.

## Changes

We may update these terms as the service changes. The date above says when they
last changed. Continuing to use the service after a change means you accept it.

## Law

These terms are governed by the laws of ${OPERATOR.jurisdiction}, and its
courts have jurisdiction over disputes arising from them.

## Contact

${OPERATOR.name}
${OPERATOR.postalAddress}
${OPERATOR.contactEmail}
`.trim(),
}
