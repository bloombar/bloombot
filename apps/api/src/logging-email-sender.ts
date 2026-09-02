/**
 * Chooses this process's `EmailSender` (AUTH-5, OPS-14) — a stand-in for
 * development/test, and, as of this slice, a real SMTP transport
 * (`@bloombot/mail`) wherever one is configured, most importantly in
 * production.
 *
 * `@bloombot/auth`'s `email.ts` ships the `EmailSender` port and a
 * `RecordingEmailSender` for tests (docs/DECISIONS.md D-19: "the real
 * implementation ... is a later slice's adapter package", D-46 for that
 * slice's own reasoning); this file is this process's own chooser, so
 * `src/index.ts` has something to hand `requestSignInLink` that is honest
 * about what it does. `LoggingEmailSender` below is that stand-in — a
 * sign-in link is a bearer credential (`redeemSignInLink` turns it into a
 * thirty-day session), so it is never one of the fields this sender writes
 * to the log. Only the recipient and subject are recorded, at `info` level,
 * visible to whoever operates it — enough to confirm mail is "sending"
 * without putting a credential in `logs/*.log`, a protected path in this
 * repo for exactly this reason (must-fix 1 of the API-1..6 rework: the
 * previous version logged the whole body, link included).
 */

import { z } from 'zod'

import type { Logger } from '@bloombot/logger'
import type { EmailSender } from '@bloombot/auth'
import { createSmtpEmailSender } from '@bloombot/mail'

import { FileEmailSender } from './file-email-sender.js'

// "Also fix" of the AUTH-5 rework: `MAIL_FROM=Bloombot` (a plausible typo
// for `MAIL_FROM=Bloombot <noreply@bloombot.example>`) parsed as a
// non-empty string, so `buildSmtpEmailSender`'s own `!smtp.from` check
// waved it through — this process started happily, and a real relay
// rejected or spam-filed every sign-in with a 500 as the only symptom, no
// different from any other rejected-recipient failure. The same `z.email()`
// `routes/auth.ts` already validates a caller's own address with, applied
// to whichever half of `MAIL_FROM` is actually the address.
const fromAddressSchema = z.email()

/** The address half of a `MAIL_FROM` value — either a bare `user@domain` or the display-name form `Name <user@domain>` (env.example documents both as accepted). */
function extractFromAddress(from: string): string {
  const match = /<([^>]+)>\s*$/.exec(from)
  return match ? match[1]! : from
}

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
 * The SMTP configuration `src/index.ts` reads off the environment —
 * `host`/`port`/`from` through `@bloombot/config`'s schema (validated at
 * startup, the same as every other non-secret configuration value), `user`/
 * `password` read directly the way `BOT_TOKEN`/`OPENAI_API_KEY` already are
 * (CFG-5: a credential, not part of the schema). `host: ''` (its schema
 * default) is this type's own "unset" — `isSmtpConfigured` below is the one
 * place that reads it that way.
 */
export interface SmtpEnv {
  host: string
  port: number
  from: string
  user: string | undefined
  password: string | undefined
}

function isSmtpConfigured(smtp: SmtpEnv): boolean {
  return smtp.host !== ''
}

/**
 * Build the real SMTP sender, or throw naming exactly what is missing —
 * this is the "misconfigured" half of AUTH-5's own text ("a process that is
 * configured to send mail and cannot must fail where an operator sees it"):
 * a structural gap (no host, no from address, half an auth pair) fails here,
 * at startup, before this process ever accepts a request. A relay that is
 * fully configured but unreachable, or that rejects a specific send, is a
 * different failure — `@bloombot/mail#createSmtpEmailSender`'s own `send()`
 * throws a classified `MailTransportError` for that instead, surfaced to
 * `requestSignInLink`'s own caller (`routes/auth.ts`'s `.catch(next)` →
 * `middleware/errors.ts`) rather than swallowed here.
 */
function buildSmtpEmailSender(smtp: SmtpEnv, logger: Logger): EmailSender {
  if (!smtp.host || !smtp.from) {
    throw new Error(
      'apps/api: no real mail transport is configured. MAIL_SMTP_HOST and ' +
        'MAIL_FROM must both be set to send real mail (see env.example) — ' +
        'required in NODE_ENV=production, since there is no development ' +
        'stand-in this process may fall back to there.'
    )
  }
  if (!fromAddressSchema.safeParse(extractFromAddress(smtp.from)).success) {
    // MAIL_FROM is not a credential (env.example, CFG-5) — safe to echo
    // back in full, the same way a malformed request address is safe for
    // `routes/auth.ts` to report in its own 400.
    throw new Error(
      `apps/api: MAIL_FROM does not parse to a valid address (see env.example): "${smtp.from}"`
    )
  }
  if ((smtp.user && !smtp.password) || (!smtp.user && smtp.password)) {
    // Named without repeating either value — this message itself ends up in
    // a startup failure an operator reads, never a place a credential
    // belongs.
    throw new Error(
      'apps/api: MAIL_SMTP_USER and MAIL_SMTP_PASSWORD must be set together, or not at all.'
    )
  }
  return createSmtpEmailSender({
    host: smtp.host,
    port: smtp.port,
    from: smtp.from,
    ...(smtp.user && smtp.password
      ? { auth: { user: smtp.user, pass: smtp.password } }
      : {}),
    logger,
  })
}

/**
 * This process's `EmailSender`, chosen from the environment (OPS-14, AUTH-5).
 *
 * In order:
 *
 * 1. **`NODE_ENV=production` — SMTP, or refuse to start.** Checked first and
 *    unconditionally, before `mailFile` is even read at all — this branch
 *    never consults it, whether or not it is set (must-fix 1 of the
 *    API-1..6 rework — this ordering predates SMTP and stays exactly as
 *    strict now that a production deployment has somewhere real to send
 *    mail). What that means for a stray `MAIL_FILE` in production depends
 *    on whether SMTP is configured, and the two are different failures: if
 *    it is not, this process refuses to start outright (`buildSmtpEmailSender`
 *    below); if it is, `MAIL_FILE` is silently ignored — never the thing
 *    that decides anything — rather than fatal. Either way it is not
 *    honoured: must-fix 4 of the AUTH-5 rework closes the one dangerous
 *    reading of "checked first" a reviewer found still open — moving the
 *    `if (mailFile) return new FileEmailSender(mailFile)` branch itself
 *    inside the production branch, ahead of the SMTP check, would leave
 *    every test that predates that fix green while a production box with
 *    SMTP configured *and* a stray `MAIL_FILE` started silently appending
 *    fifteen-minute bearer credentials to a file on the host — see
 *    `apps/api/tests/file-email-sender.test.ts`'s own test for exactly that
 *    combination.
 * 2. **`MAIL_FILE` set, outside production.** Writes each message to that
 *    file so a developer can complete a local sign-in — the link is a
 *    credential and cannot be recovered any other way, since tokens are
 *    stored hashed and the logging stand-in never writes a link.
 * 3. **SMTP configured, outside production.** Lets a developer or a staging
 *    deployment exercise the real transport without `NODE_ENV=production`'s
 *    own stricter refusal — `MAIL_FILE` still wins when both are set, since
 *    it is the more convenient way to read a link back locally.
 * 4. **Neither.** The logging stand-in.
 *
 * @throws {Error} in production, when SMTP is not fully configured — see
 *   `buildSmtpEmailSender`.
 */
export function buildEmailSender(
  nodeEnv: string,
  mailFile: string | undefined,
  smtp: SmtpEnv,
  logger: Logger
): EmailSender {
  if (nodeEnv === 'production') {
    return buildSmtpEmailSender(smtp, logger)
  }
  if (mailFile) {
    logger.info(
      { mailFile },
      'apps/api: writing sign-in emails to a file (development only) — it holds live sign-in links'
    )
    return new FileEmailSender(mailFile)
  }
  if (isSmtpConfigured(smtp)) {
    return buildSmtpEmailSender(smtp, logger)
  }
  return buildLoggingEmailSender(nodeEnv, logger)
}
