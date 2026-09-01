/**
 * Stands in for a real mail transport until one exists.
 *
 * `@bloombot/auth`'s `email.ts` ships the `EmailSender` port and a
 * `RecordingEmailSender` for tests (docs/DECISIONS.md D-19: "the real
 * implementation ... is a later slice's adapter package"); this file is
 * this process's own, so `src/index.ts` has something to hand
 * `requestSignInLink` that is honest about what it does — every sign-in
 * link is written to this process's own log at `info` level, visible to
 * whoever operates it, rather than either silently dropped or sent through
 * a credential this slice was told not to invent. Replace this with a real
 * transport (SMTP, a transactional-email API) in the slice that adds one;
 * nothing else in this file needs to change on that day — it is the same
 * `EmailSender` port either way.
 */

import type { Logger } from '@bloombot/logger'
import type { EmailSender } from '@bloombot/auth'

export class LoggingEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  send(to: string, subject: string, body: string): Promise<void> {
    this.logger.info(
      { to, subject, body },
      'apps/api: no real mail transport configured — logging the email that would have been sent'
    )
    return Promise.resolve()
  }
}
