/**
 * The mail port `sign-in.ts` sends a sign-in link through.
 *
 * A port, not an SMTP client (docs/ARCHITECTURE.md's "the consumer defines
 * the interface and the vendor code implements it") — this package ships the
 * interface and a recording fake for tests, never a real mail transport. The
 * real implementation (an SMTP client, or a transactional-email API) is a
 * later slice's adapter package, the same relationship `packages/openai` has
 * to `packages/core`'s `ModelClient`.
 */

/** Sends one email. Implementations may throw; `sign-in.ts` does not catch on the caller's behalf. */
export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>
}

/** One message `RecordingEmailSender` captured, for a test to assert against. */
export interface RecordedEmail {
  to: string
  subject: string
  body: string
}

/**
 * A test double that records every call instead of sending anything —
 * nothing in this package's own test suite needs, or is permitted, to reach
 * a real mail transport.
 */
export class RecordingEmailSender implements EmailSender {
  readonly sent: RecordedEmail[] = []

  send(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ to, subject, body })
    return Promise.resolve()
  }
}
