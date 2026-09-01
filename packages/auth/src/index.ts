/** Public surface of `@bloombot/auth` (AUTH-1..4). */

export {
  issueSignInToken,
  consumeSignInToken,
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  type IssuedSignInToken,
  type ConsumedSignInToken,
} from './tokens.js'

export {
  createSession,
  validateSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_AGE_MS,
  type CreatedSession,
  type ValidSession,
} from './sessions.js'

export {
  createGoogleIdTokenVerifier,
  type GoogleIdTokenVerifier,
  type GoogleIdTokenVerificationResult,
  type CreateGoogleIdTokenVerifierOptions,
} from './google.js'

export {
  decideLinkOutcome,
  type GoogleIdentity,
  type LinkDecision,
} from './link.js'

export {
  requestSignInLink,
  redeemSignInLink,
  signInWithGoogle,
  type RequestSignInLinkDeps,
  type SignInResult,
} from './sign-in.js'

export { isPlatformAdministrator } from './admin.js'

export {
  beginDiscordInstall,
  consumeDiscordInstallState,
  DEFAULT_INSTALL_STATE_TTL_MS,
  type BeginDiscordInstall,
  type ConsumedDiscordInstall,
} from './discord-install.js'

export {
  type EmailSender,
  type RecordedEmail,
  RecordingEmailSender,
} from './email.js'
