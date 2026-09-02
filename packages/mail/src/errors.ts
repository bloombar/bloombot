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
 * so for a `rejected` or `auth_failed` classification `classifySmtpError`
 * reads only the bounded, protocol-level facts a nodemailer error carries
 * — `code`, `command` (the SMTP verb in progress, e.g. `DATA`/`AUTH`) and
 * `responseCode` (the three-digit SMTP status) — and never touches
 * `response` or the underlying `error.message` itself, either of which the
 * *remote server* controls the content of.
 *
 * `connection_failed` and `timed_out` are different, and a rework of this
 * file keeps their `error.message` rather than discarding it too: neither
 * kind ever reaches a remote server's own reply at all — `ECONNREFUSED`,
 * `ENOTFOUND`, `Connection timeout` and a TLS trust failure's own
 * `"self-signed certificate; if the root CA is installed locally, try
 * running Node.js with --use-system-ca"` are generated locally, by Node's
 * own `net`/`tls` stack and nodemailer's own timeout logic, before any SMTP
 * conversation with the far end even begins — none of them can carry a
 * fragment of the message being sent, the same way `packages/openai`'s own
 * `errors.ts#timeoutError` needs no sanitizing either. Discarding them
 * anyway was itself a bug (D-46's rework): a certificate a private
 * institutional CA issued (the exact case D-46 targets — a university's own
 * relay) and a relay that is simply down produced the identical
 * `{"kind":"connection_failed","code":"ESOCKET"}` log line, with nothing
 * anywhere pointing an operator at the actual cause. Keeping the message
 * for these two kinds only is the fix.
 */

/** What kind of failure this was — informs whether a caller might reasonably retry, without this package making that call itself (`sign-in.ts` does not catch on the caller's behalf either). */
export type MailErrorKind =
  'auth_failed' | 'connection_failed' | 'timed_out' | 'rejected' | 'unknown'

/**
 * Kinds whose underlying `error.message` is safe to keep — see this file's
 * own module comment for why exactly these two and no others.
 */
const KINDS_WITH_SAFE_MESSAGE = new Set<MailErrorKind>([
  'connection_failed',
  'timed_out',
])

/** The bounded, protocol-level facts a nodemailer send failure can carry, plus its own `message` — kept only for the two kinds `KINDS_WITH_SAFE_MESSAGE` names; never `response`. */
interface SmtpErrorShape {
  code?: unknown
  command?: unknown
  responseCode?: unknown
  message?: unknown
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
      // send). ESOCKET also covers a TLS *trust* failure (a self-signed or
      // privately-issued certificate) — this file's own module comment on
      // why its `message` is kept.
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
 * error. For `auth_failed`/`rejected`/`unknown`, `message` is built
 * entirely from the bounded facts above, so whatever this ends up logged
 * inside (`middleware/errors.ts`'s `logger.error({ err: error, ... })` in
 * `apps/api`, in particular) carries nothing from the message this was
 * trying to send. For `connection_failed`/`timed_out`, the underlying
 * `error.message` is appended too — see the module comment.
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
    const localMessage =
      KINDS_WITH_SAFE_MESSAGE.has(kind) && typeof shape.message === 'string'
        ? shape.message
        : undefined
    const parts = [
      code ? `code=${code}` : undefined,
      command ? `command=${command}` : undefined,
      responseCode !== undefined ? `responseCode=${responseCode}` : undefined,
    ].filter((part): part is string => part !== undefined)
    const summary = parts.length ? `: ${parts.join(' ')}` : ''
    const detail = localMessage ? ` — ${localMessage}` : ''
    super(`mail transport (SMTP) send failed${summary}${detail}`)
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
