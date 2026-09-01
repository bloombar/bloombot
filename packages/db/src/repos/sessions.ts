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

import { and, eq, gt, inArray, isNull } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { accounts, sessions } from '../schema.js'

export type Session = typeof sessions.$inferSelect

/** Fields the caller supplies when creating a session. */
export interface NewSession {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  accountId: string
  /** SHA-256 hash of the session token; see `@bloombot/auth`'s `sessions.ts`. */
  tokenHash: string
  expiresAt: number
  /**
   * Defaults to `Date.now()` when omitted. `@bloombot/auth`'s `rotateSession`
   * passes the session being replaced's own `createdAt` through here rather
   * than letting it default — carrying the *original* creation time forward
   * across a chain of rotations is what lets that function cap how old a
   * chain is allowed to get, rather than each rotation resetting the clock.
   */
  createdAt?: number
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
      createdAt: input.createdAt ?? now,
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
 * one that has expired, and one whose *account* is disabled (finding 3 of
 * the AUTH-1..4 rework: `accounts.disabled_at` is the platform's
 * suspend-without-deleting control, and a live session must stop validating
 * the moment the account is disabled, not merely at the session's own TTL).
 * The disabled check is a subquery, not a join, so this stays one
 * `UPDATE ... WHERE` statement rather than needing SQLite's
 * `UPDATE ... FROM` (D-2: plain, portable SQL).
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
        gt(sessions.expiresAt, now),
        inArray(
          sessions.accountId,
          db
            .select({ id: accounts.id })
            .from(accounts)
            .where(isNull(accounts.disabledAt))
        )
      )
    )
    .returning()
    .get()
}

/**
 * Revoke a single session by its token hash.
 *
 * Returns the revoked row, or `undefined` if the hash does not exist, was
 * already revoked, or has already expired — `now` is checked the same way
 * `validateSession` checks it (finding 1 of the AUTH-1..4 rework: revoking
 * an already-dead session must not report "an active session just ended",
 * and `@bloombot/auth`'s `rotateSession` must not be able to turn an
 * expired token into a live one by reading a defined return value here as
 * proof the session it names was still alive). `@bloombot/auth`'s
 * `rotateSession` reads `accountId` and `createdAt` off this return value to
 * create the replacement session in the same transaction.
 */
export function revokeSessionByHash(
  tokenHash: string,
  now: number,
  db: Executor
): Session | undefined {
  return db
    .update(sessions)
    .set({ revokedAt: Date.now() })
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
