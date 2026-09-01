/**
 * The Discord install flow's OAuth+PKCE state (TEN-4): begin an attempt from
 * a signed-in session, and redeem it exactly once on callback.
 *
 * Mirrors `tokens.ts`'s sign-in-token shape closely — a random secret,
 * returned once and stored only as a hash — extended with the PKCE half
 * AUTH-2's own "OAuth 2.0 with PKCE" already establishes for Google: a
 * `code_verifier` this server generates and keeps to itself, and the
 * `code_challenge` (its S256 hash, RFC 7636 §4.2) that goes into the
 * authorization URL instead. Unlike the state, the verifier is stored in
 * plain text — see `beginDiscordInstall`'s own doc comment below, and
 * docs/DECISIONS.md D-21, for why hashing it would defeat its own purpose.
 *
 * This file has no notion of Discord's own endpoint shape — building the
 * authorization URL from what `beginDiscordInstall` returns is
 * `@bloombot/discord-rest`'s job, the same "the consumer defines the
 * interface, the vendor code knows the wire shape" split `google.ts`'s own
 * module comment describes for Google.
 */

import { createHash } from 'node:crypto'

import { discordInstallStates, type Database } from '@bloombot/db'

import { generateSecret, hashSecret } from './secrets.js'

// TEN-4: "a short expiry". Ten minutes is long enough to review and approve
// Discord's own consent screen without a delivery delay to accommodate —
// unlike AUTH-1's emailed link, this state never leaves this server except
// as a URL parameter and a same-site POST body, so there is no mail queue to
// wait on — and short enough that an abandoned attempt cannot be resumed
// hours later.
export const DEFAULT_INSTALL_STATE_TTL_MS = 10 * 60 * 1000

/** RFC 7636 §4.2's S256 code challenge: base64url(SHA-256(verifier)), no padding. */
function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

/** What beginning an install returns — everything a caller needs to build Discord's authorization URL, and nothing it needs to store itself. */
export interface BeginDiscordInstall {
  /** Embed as the `state` query parameter. Single-use; presented back to `consumeDiscordInstallState` on callback. */
  state: string
  /** Embed as the `code_challenge` query parameter, with `code_challenge_method=S256`. The verifier itself never leaves this function — it stays in the database until the callback needs it. */
  codeChallenge: string
  expiresAt: number
}

/**
 * Begin a Discord install attempt (TEN-4): generates a state and a PKCE
 * verifier, stores the verifier — in plain text, deliberately unlike every
 * other secret this package handles: PKCE's verifier is not a bearer
 * credential a caller ever presents back to us to prove anything, it is a
 * value *this server* generated for itself and must hand to Discord's token
 * endpoint, verbatim, to complete the exchange the callback runs later — a
 * hash could never be turned back into the value that produced it. See
 * docs/DECISIONS.md D-21. The state's *hash* is stored instead
 * (`generateSecret`/`hashSecret`, the same device `tokens.ts` uses for a
 * sign-in token), because unlike the verifier, the state *is* a bearer
 * secret: whoever presents the right one on callback is trusted to be the
 * caller this attempt began for.
 */
export function beginDiscordInstall(
  organizationId: string,
  accountId: string,
  db: Database,
  ttlMs: number = DEFAULT_INSTALL_STATE_TTL_MS
): BeginDiscordInstall {
  const now = Date.now()
  // Cheap-fix 8 of the TEN-4..6 rework: sweep every already-expired row
  // before adding one more — see `deleteExpiredInstallStates`'s own doc
  // comment (`@bloombot/db`) for why a sweep-on-write, not a "one live
  // attempt" refusal, is the guard this function takes against an
  // unbounded number of dead rows.
  discordInstallStates.deleteExpiredInstallStates(now, db)

  const state = generateSecret()
  const codeVerifier = generateSecret()
  const expiresAt = now + ttlMs
  discordInstallStates.createInstallState(
    {
      organizationId,
      accountId,
      stateHash: hashSecret(state),
      codeVerifier,
      expiresAt,
    },
    db
  )
  return {
    state,
    codeChallenge: computeCodeChallenge(codeVerifier),
    expiresAt,
  }
}

/** What a redeemed install state resolves to. */
export interface ConsumedDiscordInstall {
  organizationId: string
  accountId: string
  /** The PKCE verifier this attempt began with — pass to the token exchange's `code_verifier` field, verbatim. */
  codeVerifier: string
}

/**
 * Redeem an install state (TEN-4): single-use, and — like
 * `tokens.ts#consumeSignInToken` for AUTH-1 — indistinguishable in its
 * refusal for a state that never existed, one already used, and one that
 * has expired, so a callback cannot learn which of the three happened.
 */
export function consumeDiscordInstallState(
  state: string,
  db: Database
): ConsumedDiscordInstall | undefined {
  const consumed = discordInstallStates.consumeInstallState(
    hashSecret(state),
    Date.now(),
    db
  )
  return consumed
    ? {
        organizationId: consumed.organizationId,
        accountId: consumed.accountId,
        codeVerifier: consumed.codeVerifier,
      }
    : undefined
}
