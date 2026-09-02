/**
 * AUTH-5 — the real mail transport. `EmailSender` (`@bloombot/auth`'s
 * `email.ts`) is the port; this is the one adapter that knows nodemailer
 * exists, the same relationship `packages/openai` has to `packages/core`'s
 * `ModelClient` (docs/ARCHITECTURE.md's "ports and adapters").
 *
 * SMTP over an HTTP transactional-email API: every institution this
 * platform targets already has an SMTP relay (their own, or their Google
 * Workspace/Microsoft 365 tenant's) that a university IT department is
 * already comfortable issuing credentials against — no vendor SDK, no
 * account to create with a third party, and it keeps `EmailSender` honest
 * as a port: "send this to that address" is exactly what SMTP does, with
 * nothing provider-specific leaking into the interface the way a
 * transactional-email API's own delivery-tracking or template features
 * would tempt one to. `docs/DECISIONS.md`'s D-46 has the full reasoning.
 *
 * `createSmtpEmailSender` is a factory, not a module-level client (PLAT-5):
 * nothing here opens a connection until `send()` is actually called —
 * nodemailer's own transporter dials per message rather than at
 * construction, so building this adapter has no side effect of its own.
 */

import nodemailer from 'nodemailer'

import type { EmailSender } from '@bloombot/auth'
import type { Logger } from '@bloombot/logger'

import { classifySmtpError } from './errors.js'

/** SMTP credentials, when the relay requires them — not every relay does (an internal, IP-allowlisted one may not). */
export interface SmtpAuth {
  user: string
  pass: string
}

export interface CreateSmtpEmailSenderOptions {
  /** The relay's hostname. Required — there is no "real" default the way `OPENAI_BASE_URL` has one; a mail relay is always institution-specific. */
  host: string
  /** The relay's port. 465 is treated as implicit TLS (`secure: true`); anything else negotiates TLS via STARTTLS (see `requireTLS` below). */
  port: number
  /** The `From:` header every message is sent with. Required — an SMTP server may accept a message with none, but silently, and a reply-less sender is not a real "who is this from" answer for a sign-in email. */
  from: string
  auth?: SmtpAuth
  logger: Logger
  /**
   * Whether a non-465 connection must negotiate STARTTLS before nodemailer
   * will send anything. Defaults to `true` — a sign-in link is a bearer
   * credential (AUTH-5's own constraint), and it must not cross the network
   * in the clear. The only reason this is a parameter at all rather than a
   * hardcoded `true` is `tests/smtp.test.ts`: the loopback fake SMTP server
   * this package's own tests run against does not speak TLS, and standing
   * one up that did would test nodemailer's TLS handshake, not this
   * adapter's own logic. Never set to `false` outside a test.
   */
  requireTLS?: boolean
  /**
   * A CA certificate (PEM) nodemailer should trust in addition to Node's
   * own default trust store, for the STARTTLS handshake this adapter
   * negotiates. Not read from configuration anywhere — `apps/api` never
   * sets it, and there is no `MAIL_SMTP_CA` env var (must-fix 3 of the
   * AUTH-5 rework documents `NODE_EXTRA_CA_CERTS` in `env.example` as the
   * real deployment's own way to trust a private institutional CA instead,
   * a Node runtime flag rather than something this package reads). This
   * exists solely so `tests/smtp.test.ts` can prove a real STARTTLS
   * handshake actually succeeds, against a self-signed certificate the test
   * itself generates — the one thing `requireTLS: false` (above) cannot
   * prove, since it skips TLS entirely rather than completing it.
   */
  tlsCaPem?: string
}

// "Also fix" of the AUTH-5 rework: nodemailer's own defaults left both
// unbounded enough that a relay which accepts the TCP connection and then
// never speaks — never sends its own greeting, the one case none of
// `errors.ts`'s classified kinds above were reproduced against — held
// `send()` open for tens of seconds. `/auth/request-link` is
// unauthenticated (AUTH-1), so an unbounded hold on it is a resource-hold
// vector, not merely a slow error message. Ten seconds is generous for a
// relay actually listening (loopback and a real campus relay both resolve
// in milliseconds) and short enough that a caller — and the request
// admission this API otherwise has no other bound on for this route — is
// not left hanging on a relay that never will.
export const CONNECTION_TIMEOUT_MS = 10_000
// Deliberately shorter than CONNECTION_TIMEOUT_MS, not merely equal to it:
// nodemailer treats the two as one continuous deadline when they match, so
// a relay that accepts the TCP connection and then never greets reports the
// generic "Timeout"/CONN rather than the specific "Greeting never
// received" — reproduced while writing this, and the reason
// `tests/smtp.test.ts`'s own greeting-timeout test needed this exact gap to
// assert the more diagnostic message at all.
export const GREETING_TIMEOUT_MS = 8_000
export const SOCKET_TIMEOUT_MS = 10_000

/**
 * Build an `EmailSender` backed by a real SMTP relay.
 *
 * Validates `host`/`from` (and that `auth`, if given, carries both halves)
 * eagerly, at construction — this is the "misconfigured before a single
 * request arrives" half of AUTH-5's own text ("a process that is configured
 * to send mail and cannot must fail where an operator sees it"); the
 * per-send half is `send()` below, which never swallows a failure.
 *
 * @throws {Error} if `host` or `from` is empty.
 */
export function createSmtpEmailSender(
  options: CreateSmtpEmailSenderOptions
): EmailSender {
  if (!options.host) {
    throw new Error(
      'createSmtpEmailSender: host must be set (see MAIL_SMTP_HOST in env.example)'
    )
  }
  if (!options.from) {
    throw new Error(
      'createSmtpEmailSender: from must be set (see MAIL_FROM in env.example)'
    )
  }

  const secure = options.port === 465
  const transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure,
    // STARTTLS is required, not merely opportunistic, whenever this
    // connection is not already implicit-TLS — see this option's own doc
    // comment on `CreateSmtpEmailSenderOptions` above.
    requireTLS: secure ? undefined : (options.requireTLS ?? true),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    ...(options.tlsCaPem ? { tls: { ca: options.tlsCaPem } } : {}),
    ...(options.auth ? { auth: options.auth } : {}),
  })

  return {
    async send(to: string, subject: string, body: string): Promise<void> {
      try {
        await transporter.sendMail({
          from: options.from,
          to,
          subject,
          text: body,
        })
        // Only the recipient and subject — never `body`, a sign-in link is
        // a bearer credential (this file's own module comment, and
        // `apps/api/src/logging-email-sender.ts`'s identical rule for its
        // own stand-in).
        options.logger.info({ to, subject }, 'apps/mail: sent')
      } catch (error) {
        const classified = classifySmtpError(error)
        // `classified.message` carries only what `errors.ts`'s own module
        // comment says is safe for this `kind` — bounded protocol facts for
        // most, plus a locally-generated message for `connection_failed`/
        // `timed_out` only — never `error` itself, which this catch block
        // never touches again.
        options.logger.error(
          {
            to,
            subject,
            kind: classified.kind,
            code: classified.code,
            command: classified.command,
            responseCode: classified.responseCode,
          },
          'apps/mail: send failed'
        )
        throw classified
      }
    },
  }
}
