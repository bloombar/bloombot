/**
 * Repository for `sessions` (AUTH-3).
 *
 * Organization-independent, like `sign-in-tokens.ts`: a session
 * authenticates an account, not a membership in one particular organization,
 * so every function here is keyed on `accountId` rather than
 * `organizationId` — allowlisted in `tests/tenant-scoping-convention.test.ts`
 * accordingly. Every function operates on the session token's *hash*; the
 * plaintext value is generated and returned to the caller exactly once, by
 * `@bloombot/auth`'s `sessions.ts`, and is never written to this table. That
 * is the whole reason a hash is stored rather than the token itself:
 * revoking a session (one, or every one an account holds) only has to find
 * and mark rows, never to recover a secret a stolen row could then replay.
 */

import { and, eq, gt, isNull } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { sessions } from '../schema.js'

export type Session = typeof sessions.$inferSelect

/** Fields the caller supplies when creating a session. */
export interface NewSession {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  accountId: string
  /** SHA-256 hash of the session token; see `@bloombot/auth`'s `sessions.ts`. */
  tokenHash: string
  expiresAt: number
}

/** Create a new session row. */
export function createSession(input: NewSession, db: Executor): Session {
  const now = Date.now()
  return db
    .insert(sessions)
    .values({
      id: input.id ?? crypto.randomUUID(),
      accountId: input.accountId,
      tokenHash: input.tokenHash,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
    })
    .returning()
    .get()
}

/**
 * Validate a session by its token hash and, if valid, touch `lastSeenAt`.
 *
 * A single conditional `UPDATE ... RETURNING`, not a `SELECT` followed by an
 * `UPDATE`: `where` re-checks `revoked_at`/`expires_at` on the same
 * statement that records the visit, so a session revoked or expired a
 * moment ago cannot be "seen" one more time by a request already in flight.
 * Returns `undefined` for a hash that does not exist, one that is revoked,
 * and one that has expired.
 */
export function validateSession(
  tokenHash: string,
  now: number,
  db: Executor
): Session | undefined {
  return db
    .update(sessions)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      )
    )
    .returning()
    .get()
}

/**
 * Revoke a single session by its token hash.
 *
 * Returns the revoked row, or `undefined` if the hash does not exist or was
 * already revoked — `@bloombot/auth`'s `rotateSession` reads `accountId` off
 * this return value to create the replacement session in the same
 * transaction.
 */
export function revokeSessionByHash(
  tokenHash: string,
  db: Executor
): Session | undefined {
  return db
    .update(sessions)
    .set({ revokedAt: Date.now() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .returning()
    .get()
}

/**
 * Revoke every active session belonging to an account (AUTH-3: "revocation
 * must work for ... every session of an account").
 *
 * Returns the number of sessions revoked.
 */
export function revokeAllSessionsForAccount(
  accountId: string,
  db: Executor
): number {
  const result = db
    .update(sessions)
    .set({ revokedAt: Date.now() })
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)))
    .run()
  return result.changes
}
