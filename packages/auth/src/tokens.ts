/**
 * Single-use sign-in tokens (AUTH-1).
 *
 * Everything a token *is* — random, returned once, stored only as a hash,
 * single-use, minutes-lived — lives here. What a redeemed token *does*
 * (find or create the account, open a session) is `sign-in.ts`'s job: this
 * module never imports `accounts.ts` or `sessions.ts`, and `consumeSignInToken`
 * is written to be called from inside a caller-owned `db.transaction(...)`
 * so the redemption and whatever it unlocks commit or fail together.
 */

import { signInTokens, type Database, type Executor } from '@bloombot/db'
import { z } from 'zod'

import { generateSecret, hashSecret } from './secrets.js'

const emailSchema = z.email()

// AUTH-1: "expire within minutes". Fifteen minutes is long enough that an
// email delivered a little late (a slow mail queue, a spam-filter delay)
// still works, short enough that a link sitting unread in an inbox — or
// forwarded, or leaked via a mail provider's own logs — stops being useful
// well within the same sitting.
export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000

// Finding 5 of the AUTH-1..4 rework: `issueSignInToken`'s `ttlMs` parameter
// had no upper bound, so a caller could issue a link that stayed valid for
// months — AUTH-1's "expire within minutes" would then be a convention a
// caller could simply not follow, rather than something this module
// actually enforces. Equal to `DEFAULT_TOKEN_TTL_MS`: nothing about a
// sign-in link needs to live longer than the deliberately-chosen default,
// so there is no legitimate reason for a caller to ask for more.
export const MAX_TOKEN_TTL_MS = DEFAULT_TOKEN_TTL_MS

/** What a caller gets back from issuing a token — the plaintext value, exactly once. */
export interface IssuedSignInToken {
  /** The value to put in the emailed link. Never recoverable from the database afterward. */
  token: string
  expiresAt: number
}

/**
 * Issue a new sign-in token for an email address.
 *
 * Does not check whether an account with this email exists — a first-time
 * sign-in and a returning one request a link the same way; `sign-in.ts`
 * decides at redemption time whether to create an account. Does reject a
 * malformed address up front (`zod`'s own `email()` check) — refusing here
 * is cheap and immediate, versus discovering the same problem only once
 * something tries, and fails, to send mail to it. `ttlMs` is clamped to
 * `MAX_TOKEN_TTL_MS` (finding 5 of the AUTH-1..4 rework) — a caller asking
 * for less than the default still gets exactly what it asked for; only a
 * request for *more* than the ceiling is capped.
 *
 * @throws {z.ZodError} if `email` is not a syntactically valid address.
 */
export function issueSignInToken(
  email: string,
  db: Database,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS
): IssuedSignInToken {
  emailSchema.parse(email)
  const token = generateSecret()
  const expiresAt = Date.now() + Math.min(ttlMs, MAX_TOKEN_TTL_MS)
  signInTokens.createSignInToken(
    { email, tokenHash: hashSecret(token), expiresAt },
    db
  )
  return { token, expiresAt }
}

/** What a redeemed token resolves to. */
export interface ConsumedSignInToken {
  email: string
}

/**
 * Redeem a sign-in token: single-use, and atomic with whatever the caller
 * does next.
 *
 * Call this *inside* the same `db.transaction(...)` that creates the
 * session (AUTH-1) — `db` here should be the transaction's own handle, not
 * a fresh connection, so a failure later in that transaction (account
 * creation, session creation) rolls the redemption back too rather than
 * burning the token on a sign-in that never completed.
 *
 * Returns `undefined` for a token that never existed, one already redeemed,
 * and one that has expired — identically in all three cases, so a caller
 * cannot use the response to tell replay apart from a wrong guess.
 */
export function consumeSignInToken(
  token: string,
  db: Executor
): ConsumedSignInToken | undefined {
  const consumed = signInTokens.consumeSignInToken(
    hashSecret(token),
    Date.now(),
    db
  )
  return consumed ? { email: consumed.email } : undefined
}
