/**
 * Repository for `sign_in_tokens` (AUTH-1).
 *
 * Organization-independent, the same reasoning `accounts.ts#getAccountByEmail`
 * documents for TEN-2's first exception — except this table sits one step
 * earlier still: the account a token resolves to may not exist yet, so there
 * is nothing to scope a row to until it is redeemed. Every function here
 * therefore takes an email or a hash, never an `organizationId`, and is
 * allowlisted in `tests/tenant-scoping-convention.test.ts` accordingly.
 *
 * Every function operates on the token's *hash*. The plaintext value is
 * generated and returned to the caller exactly once, by `@bloombot/auth`'s
 * `tokens.ts` — this file never sees it and never writes it.
 */

import { and, eq, gt, isNull } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { signInTokens } from '../schema.js'

export type SignInToken = typeof signInTokens.$inferSelect

/** Fields the caller supplies when issuing a sign-in token. */
export interface NewSignInToken {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  email: string
  /** SHA-256 hash of the token; see `@bloombot/auth`'s `tokens.ts`. */
  tokenHash: string
  expiresAt: number
}

/** Issue (insert) a new sign-in token row. */
export function createSignInToken(
  input: NewSignInToken,
  db: Executor
): SignInToken {
  return db
    .insert(signInTokens)
    .values({
      id: input.id ?? crypto.randomUUID(),
      email: input.email.toLowerCase(),
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * Redeem a token by its hash: atomically marks it used and returns the row.
 *
 * AUTH-1's "consumed in the same transaction that creates the session" is
 * this single conditional `UPDATE` — not a `SELECT` to check the row followed
 * by a separate `UPDATE` to spend it. That single statement is what makes two
 * concurrent redemptions of the same token resolve to exactly one winner:
 * SQLite serializes writers, so whichever call's `UPDATE` commits second
 * finds `used_at` already set (or, for an expired token, `expires_at` already
 * past) and matches no row — the same single-statement guard
 * `discord-servers.ts#claimDiscordServerBinding`'s re-claim branch already
 * uses for TEN-3. Call this inside the caller's own `db.transaction(...)`
 * alongside session (and, for a first-time sign-in, account) creation, so a
 * failure anywhere in that flow rolls the redemption back too.
 *
 * Returns `undefined` for a hash that was never issued, one already used,
 * and one that has expired — identically, so a caller cannot learn which of
 * the three happened (AUTH-1: no oracle).
 */
export function consumeSignInToken(
  tokenHash: string,
  now: number,
  db: Executor
): SignInToken | undefined {
  return db
    .update(signInTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(signInTokens.tokenHash, tokenHash),
        isNull(signInTokens.usedAt),
        gt(signInTokens.expiresAt, now)
      )
    )
    .returning()
    .get()
}

/**
 * Whether `email` currently has an unexpired, unused token outstanding.
 *
 * The "also worth doing" item of the API-1..6 rework: `/auth/request-link`
 * is unauthenticated and unthrottled, so without this a single address is
 * an unbounded mail-send and row-insert — `requestSignInLink`
 * (`@bloombot/auth`'s `sign-in.ts`) calls this before issuing a new token,
 * and silently declines to issue (and to send mail) a second one while an
 * earlier one for the same address is still live. Keyed on email, like every
 * other function in this file — see the module comment.
 */
export function hasActiveSignInToken(
  email: string,
  now: number,
  db: Executor
): boolean {
  const row = db
    .select({ id: signInTokens.id })
    .from(signInTokens)
    .where(
      and(
        eq(signInTokens.email, email.toLowerCase()),
        isNull(signInTokens.usedAt),
        gt(signInTokens.expiresAt, now)
      )
    )
    .get()
  return row !== undefined
}

/**
 * Delete a sign-in token row outright — AUTH-5's must-fix 1: when the mail
 * carrying a freshly issued token fails to send, the row `createSignInToken`
 * just wrote is still live and unused, so `hasActiveSignInToken` (above)
 * would otherwise treat it as an outstanding link and silently decline
 * every retry — answering `204`, sending nothing — for the rest of its
 * fifteen-minute lifetime. Unlike `consumeSignInToken`, this is not "mark
 * used": a token nobody ever received was never a legitimate single use to
 * record, so the row is removed rather than left behind with a `usedAt` a
 * later reader might mistake for a real redemption.
 */
export function deleteSignInToken(tokenHash: string, db: Executor): void {
  db.delete(signInTokens).where(eq(signInTokens.tokenHash, tokenHash)).run()
}
