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
