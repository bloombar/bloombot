/**
 * Sessions: create, validate, rotate and revoke (AUTH-3).
 *
 * Opaque random tokens, stored as hashes — the API slice that follows
 * carries the plaintext value in an HttpOnly, Secure, SameSite cookie
 * (SPEC.md AUTH-3), which is that slice's concern, not this one's. This
 * module never imports Express or a cookie library; it hands back a plain
 * string.
 */

import {
  sessions as sessionsRepo,
  type Database,
  type Executor,
} from '@bloombot/db'

import { generateSecret, hashSecret } from './secrets.js'

// AUTH-3 gives no explicit number, unlike AUTH-1's "minutes". Thirty days
// balances "a signed-in instructor stays signed in across a normal teaching
// week without re-authenticating" against "a stolen laptop's session does
// not outlive the term it was used in" — long enough to be unobtrusive,
// short enough that `revokeAllSessionsForAccount` plus a password-adjacent
// event (email change, suspected compromise) forces re-authentication
// within a bounded window even if a caller forgets to call it. See
// docs/DECISIONS.md.
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** What a caller gets back from creating or rotating a session — the plaintext token, exactly once. */
export interface CreatedSession {
  /** The value to carry in the session cookie. Never recoverable from the database afterward. */
  token: string
  sessionId: string
  accountId: string
  expiresAt: number
}

/** What a validated session proves: which account, and which session row. */
export interface ValidSession {
  sessionId: string
  accountId: string
}

/**
 * Create a new session for an account.
 *
 * `db` accepts `Executor`, not just `Database`: `rotateSession` (below) and
 * `sign-in.ts`'s two flows both call this from inside a transaction they
 * already own — a rotation's replacement session, or a first sign-in's —
 * rather than opening a second, unrelated one of its own.
 */
export function createSession(
  accountId: string,
  db: Executor,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): CreatedSession {
  const token = generateSecret()
  const expiresAt = Date.now() + ttlMs
  const row = sessionsRepo.createSession(
    { accountId, tokenHash: hashSecret(token), expiresAt },
    db
  )
  return { token, sessionId: row.id, accountId: row.accountId, expiresAt }
}

/**
 * Validate a session token.
 *
 * Returns `undefined` for a token that does not exist, one that was
 * revoked, and one that has expired — a session that fails validation for
 * any reason is simply not signed in; the caller does not get to
 * distinguish why. Touches the session's `lastSeenAt` as a side effect of a
 * successful validation.
 */
export function validateSession(
  token: string,
  db: Database
): ValidSession | undefined {
  const row = sessionsRepo.validateSession(hashSecret(token), Date.now(), db)
  return row ? { sessionId: row.id, accountId: row.accountId } : undefined
}

/**
 * Rotate a session: the old token stops working and a new one is issued for
 * the same account, atomically (AUTH-3: "rotated on sign-in").
 *
 * Returns `undefined` if `token` does not name a currently-active session —
 * an already-revoked or expired token cannot be rotated into a live one.
 */
export function rotateSession(
  token: string,
  db: Database,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): CreatedSession | undefined {
  return db.transaction((tx) => {
    const revoked = sessionsRepo.revokeSessionByHash(hashSecret(token), tx)
    if (!revoked) return undefined
    return createSession(revoked.accountId, tx, ttlMs)
  })
}

/**
 * Revoke a single session by its token.
 *
 * Returns whether a session was actually revoked — `false` for a token that
 * does not exist or was already revoked, so a caller can tell "nothing to
 * do" from "an active session just ended" without the two looking alike to
 * an attacker probing tokens (the row is found or not found by its hash
 * either way; nothing here refuses differently for "wrong" versus
 * "already-used").
 */
export function revokeSession(token: string, db: Database): boolean {
  return sessionsRepo.revokeSessionByHash(hashSecret(token), db) !== undefined
}

/**
 * Revoke every active session belonging to an account (AUTH-3: "revocation
 * ... for ... every session of an account") — the administrative "sign this
 * account out everywhere" action, and what storing hashes rather than
 * tokens is what makes possible in the first place: this never needs to
 * recover a token to invalidate it, only to find the rows.
 *
 * Returns the number of sessions revoked.
 */
export function revokeAllSessions(accountId: string, db: Database): number {
  return sessionsRepo.revokeAllSessionsForAccount(accountId, db)
}
