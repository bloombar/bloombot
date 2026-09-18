/** Public surface of `@bloombot/mail` — the SMTP adapter behind `@bloombot/auth`'s `EmailSender` port (AUTH-5). */

export {
  createSmtpEmailSender,
  type CreateSmtpEmailSenderOptions,
  type SmtpAuth,
} from './smtp.js'

export {
  MailTransportError,
  classifySmtpError,
  type MailErrorKind,
} from './errors.js'

// ADMIN-14 — moved from `apps/api/src/logging-email-sender.ts`/
// `file-email-sender.ts` so `apps/api` and `apps/worker` can share the one
// "choose a transport from the environment" selection rather than each
// keeping its own copy (`build-email-sender.ts`'s own module comment has
// the full reasoning).
export {
  buildEmailSender,
  buildLoggingEmailSender,
  LoggingEmailSender,
  type SmtpEnv,
} from './build-email-sender.js'
export { FileEmailSender } from './file-email-sender.js'
