/**
 * AUTH-5 — turns whatever nodemailer throws into a classified,
 * credential-safe error. `smtp.ts#createSmtpEmailSender` is the only place
 * this is called from, and it is called on *every* failed send, without
 * exception: the constraint the brief for this slice states explicitly is
 * that a sign-in link — a bearer credential, `redeemSignInLink` turns one
 * into a thirty-day session — must never reach a log line, an error
 * message, or an exception, "including when the transport itself fails and
 * you are tempted to log the message that did not send."
 *
 * The temptation this guards against: nodemailer's own rejection carries a
 * `response` field — the SMTP server's free-text reply — and a mail body is
 * exactly the kind of content a spam or content filter sometimes quotes
 * back in that text ("550 message rejected: contains a blocked link").
 * Nothing here can prove a given deployment's mail relay never does that,
 * so `classifySmtpError` reads only the bounded, protocol-level facts a
 * nodemailer error carries — `code` (nodemailer's own retry-classification
 * string, e.g. `EAUTH`/`ECONNECTION`), `command` (the SMTP verb in progress,
 * e.g. `DATA`/`AUTH`) and `responseCode` (the three-digit SMTP status) — and
 * never touches `response` itself. `to` and `subject` are the two fields
 * `LoggingEmailSender` (`apps/api`) already treats as safe to log; nothing
 * else about the message is threaded through.
 */

/** What kind of failure this was — informs whether a caller might reasonably retry, without this package making that call itself (`sign-in.ts` does not catch on the caller's behalf either). */
export type MailErrorKind =
  'auth_failed' | 'connection_failed' | 'timed_out' | 'rejected' | 'unknown'

/** The bounded, protocol-level facts a nodemailer send failure can carry — never its own free-text `response`. */
interface SmtpErrorShape {
  code?: unknown
  command?: unknown
  responseCode?: unknown
}

function isSmtpErrorShape(value: unknown): value is SmtpErrorShape {
  return typeof value === 'object' && value !== null
}

/**
 * nodemailer's own `code` values that mean "will not succeed without a
 * configuration change" versus "might succeed if tried again" — the same
 * two-bucket split `packages/openai/src/errors.ts#ModelRequestError.retryable`
 * already makes for the model port, generalized to SMTP's own vocabulary.
 */
function classifyCode(code: string | undefined): MailErrorKind {
  switch (code) {
    case 'EAUTH':
      return 'auth_failed'
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'EDNS':
    case 'ETLS':
      // ETLS: the STARTTLS negotiation itself failed or was refused — most
      // often a relay that does not offer STARTTLS at all, which
      // `requireTLS: true` (`smtp.ts`) refuses to fall back from rather
      // than sending the credential in the clear (verified against a real
      // loopback server while writing this: a fake server with STARTTLS
      // disabled produces exactly this code, never a successful plaintext
      // send).
      return 'connection_failed'
    case 'ETIMEDOUT':
      return 'timed_out'
    case 'EENVELOPE':
    case 'EMESSAGE':
      return 'rejected'
    default:
      return 'unknown'
  }
}

/**
 * A send failure this adapter's `send()` throws instead of nodemailer's own
 * error — `message` is built entirely from the bounded facts above, so
 * whatever this ends up logged inside (`middleware/errors.ts`'s
 * `logger.error({ err: error, ... })` in `apps/api`, in particular) carries
 * nothing from the message this was trying to send.
 */
export class MailTransportError extends Error {
  readonly kind: MailErrorKind
  /** nodemailer's own `code`, kept for an operator who wants the exact string — never `response`. */
  readonly code: string | undefined
  readonly command: string | undefined
  readonly responseCode: number | undefined

  constructor(kind: MailErrorKind, cause: unknown) {
    const shape = isSmtpErrorShape(cause) ? cause : {}
    const code = typeof shape.code === 'string' ? shape.code : undefined
    const command =
      typeof shape.command === 'string' ? shape.command : undefined
    const responseCode =
      typeof shape.responseCode === 'number' ? shape.responseCode : undefined
    const parts = [
      code ? `code=${code}` : undefined,
      command ? `command=${command}` : undefined,
      responseCode !== undefined ? `responseCode=${responseCode}` : undefined,
    ].filter((part): part is string => part !== undefined)
    super(
      `mail transport (SMTP) send failed${parts.length ? `: ${parts.join(' ')}` : ''}`
    )
    this.name = 'MailTransportError'
    this.kind = kind
    this.code = code
    this.command = command
    this.responseCode = responseCode
  }
}

/** Classify a nodemailer `sendMail` rejection into a `MailTransportError` — the one place a raw nodemailer error is read. */
export function classifySmtpError(error: unknown): MailTransportError {
  const code =
    isSmtpErrorShape(error) && typeof error.code === 'string'
      ? error.code
      : undefined
  return new MailTransportError(classifyCode(code), error)
}
