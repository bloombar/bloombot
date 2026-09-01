/**
 * Stands in for a real mail transport until one exists.
 *
 * `@bloombot/auth`'s `email.ts` ships the `EmailSender` port and a
 * `RecordingEmailSender` for tests (docs/DECISIONS.md D-19: "the real
 * implementation ... is a later slice's adapter package"); this file is
 * this process's own, so `src/index.ts` has something to hand
 * `requestSignInLink` that is honest about what it does — a sign-in link is
 * a bearer credential (`redeemSignInLink` turns it into a thirty-day
 * session), so it is never one of the fields this sender writes to the log.
 * Only the recipient and subject are recorded, at `info` level, visible to
 * whoever operates it — enough to confirm mail is "sending" without putting
 * a credential in `logs/*.log`, a protected path in this repo for exactly
 * this reason (must-fix 1 of the API-1..6 rework: the previous version
 * logged the whole body, link included). Replace this with a real transport
 * (SMTP, a transactional-email API) in the slice that adds one; nothing else
 * in this file needs to change on that day — it is the same `EmailSender`
 * port either way.
 */

import type { Logger } from '@bloombot/logger'
import type { EmailSender } from '@bloombot/auth'

import { FileEmailSender } from './file-email-sender.js'

export class LoggingEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `body` must stay part of the `EmailSender` signature this implements; it is deliberately never read, let alone logged — see the module comment above.
  send(to: string, subject: string, _body: string): Promise<void> {
    this.logger.info(
      { to, subject },
      'apps/api: no real mail transport configured — logging that an email would have been sent (not its contents)'
    )
    return Promise.resolve()
  }
}

/**
 * Build this process's `EmailSender` for the given `nodeEnv` — the stand-in
 * above for `development`/`test`, and an outright startup failure for
 * `production` (must-fix 1 of the API-1..6 rework).
 *
 * `LoggingEmailSender` never puts a credential in the log, but it still logs
 * every address `requestSignInLink` is ever called with and confirms mail
 * "sent" that nobody actually received — acceptable for a developer running
 * this locally, not acceptable as the default for real students and
 * instructors. Refusing to start is the third option D-20 did not
 * originally weigh: not "log the credential" and not "silently drop every
 * sign-in link", but "fail loudly, at startup, before this process ever
 * accepts a request" — the same discipline `CONFIG` itself already applies
 * to a bad environment (`src/index.ts`'s own comment on `PLAT-5`/`API-6`).
 *
 * @throws {Error} if `nodeEnv` is `'production'` — there is no real
 *   transport configured for this stand-in to defer to yet.
 */
export function buildLoggingEmailSender(
  nodeEnv: string,
  logger: Logger
): EmailSender {
  if (nodeEnv === 'production') {
    throw new Error(
      'apps/api: no real mail transport is configured for NODE_ENV=production. ' +
        'LoggingEmailSender is a development/test stand-in only — it must not ' +
        'be the production default (a sign-in link is a bearer credential). ' +
        'Configure a real EmailSender before starting this process in production.'
    )
  }
  return new LoggingEmailSender(logger)
}

/**
 * This process's `EmailSender`, chosen from the environment (OPS-14).
 *
 * `MAIL_FILE` outside production writes each message to that file so a
 * developer can complete a local sign-in — the link is a credential and
 * cannot be recovered any other way, since tokens are stored hashed and the
 * logging stand-in never writes a link. In production the same variable is
 * refused outright rather than honoured: writing sign-in links to a file on
 * the box serving real students is the failure this whole stand-in exists to
 * avoid, and a variable set by accident must not be the thing that causes it.
 *
 * @throws {Error} in production, whether or not `MAIL_FILE` is set — there is
 *   still no real transport for it to defer to.
 */
export function buildEmailSender(
  nodeEnv: string,
  mailFile: string | undefined,
  logger: Logger
): EmailSender {
  if (nodeEnv === 'production') {
    // Deliberately checked before `mailFile`: a stray MAIL_FILE in a
    // production environment must fail loudly, not quietly start writing
    // credentials to disk.
    return buildLoggingEmailSender(nodeEnv, logger)
  }
  if (mailFile) {
    logger.info(
      { mailFile },
      'apps/api: writing sign-in emails to a file (development only) — it holds live sign-in links'
    )
    return new FileEmailSender(mailFile)
  }
  return buildLoggingEmailSender(nodeEnv, logger)
}
