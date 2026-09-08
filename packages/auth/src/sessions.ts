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

// Finding 1 of the AUTH-1..4 rework: "rotated on sign-in" (AUTH-3) must not
// mean a session can be rotated forever. `rotateSession` carries the
// *original* session's `createdAt` forward across every rotation in a
// chain (`packages/db`'s `NewSession.createdAt`), so this is a ceiling on
// how old that chain is allowed to get before rotation itself refuses —
// six times `DEFAULT_SESSION_TTL_MS`, about six months, long enough that a
// caller who rotates on every sign-in never notices it under normal use,
// short enough that nothing stays alive on rotation alone indefinitely. See
// docs/DECISIONS.md.
export const MAX_SESSION_AGE_MS = 6 * DEFAULT_SESSION_TTL_MS

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
 * Create a new session row — `createSession`'s actual implementation,
 * taking `createdAt` explicitly rather than always defaulting it to `now`.
 * Not exported: a caller outside this file has no legitimate reason to
 * backdate a session's creation time, and `createSession`/`rotateSession`
 * below are the only two callers this needs — the latter is the one that
 * passes something other than `now`, carrying an existing chain's original
 * `createdAt` forward (finding 1 of the AUTH-1..4 rework).
 */
function createSessionRow(
  accountId: string,
  db: Executor,
  ttlMs: number,
  createdAt: number
): CreatedSession {
  const token = generateSecret()
  const expiresAt = Date.now() + ttlMs
  const row = sessionsRepo.createSession(
    { accountId, tokenHash: hashSecret(token), expiresAt, createdAt },
    db
  )
  return { token, sessionId: row.id, accountId: row.accountId, expiresAt }
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
  return createSessionRow(accountId, db, ttlMs, Date.now())
}

/**
 * Validate a session token.
 *
 * Returns `undefined` for a token that does not exist, one that was
 * revoked, one that has expired, and one whose account is disabled
 * (`packages/db`'s `validateSession` enforces the last of these directly,
 * finding 3 of the AUTH-1..4 rework) — a session that fails validation for
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
 * an already-revoked or already-*expired* token cannot be rotated into a
 * live one (finding 1 of the AUTH-1..4 rework: `revokeSessionByHash` now
 * checks expiry the same way `validateSession` does, so a token that died
 * months ago cannot be presented here to mint a fresh thirty-day session).
 * Also returns `undefined`, without reviving the old token, once the
 * session's *chain* — tracked by carrying the original `createdAt` forward
 * through every rotation — is older than `MAX_SESSION_AGE_MS`: the old
 * token is revoked either way, so this ends the chain rather than letting
 * one more rotation extend it again.
 */
export function rotateSession(
  token: string,
  db: Database,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): CreatedSession | undefined {
  const now = Date.now()
  return db.transaction((tx) => {
    const revoked = sessionsRepo.revokeSessionByHash(hashSecret(token), now, tx)
    if (!revoked) return undefined
    if (now - revoked.createdAt > MAX_SESSION_AGE_MS) return undefined
    return createSessionRow(revoked.accountId, tx, ttlMs, revoked.createdAt)
  })
}

/**
 * Revoke a single session by its token.
 *
 * Returns whether a session was actually revoked — `false` for a token that
 * does not exist, was already revoked, or has already expired (finding 1 of
 * the AUTH-1..4 rework: an expired session is already dead, so revoking it
 * is "nothing to do", not "an active session just ended") — so a caller can
 * tell "nothing to do" from "an active session just ended" without the two
 * looking alike to an attacker probing tokens (the row is found or not
 * found by its hash either way; nothing here refuses differently for
 * "wrong" versus "already-used" versus "expired").
 */
export function revokeSession(token: string, db: Database): boolean {
  return (
    sessionsRepo.revokeSessionByHash(hashSecret(token), Date.now(), db) !==
    undefined
  )
}

/**
 * Revoke every active session belonging to an account (AUTH-3: "revocation
 * ... for ... every session of an account") — the administrative "sign this
 * account out everywhere" action, and what storing hashes rather than
 * tokens is what makes possible in the first place: this never needs to
 * recover a token to invalidate it, only to find the rows.
 *
 * `db` accepts `Executor`, not just `Database`: `sign-in.ts#redeemSignInLink`
 * calls this from inside its own transaction, revoking a returning
 * account's other sessions the moment it proves control of the address
 * again (finding 2 of the AUTH-1..4 rework).
 *
 * Returns the number of sessions revoked.
 */
export function revokeAllSessions(accountId: string, db: Executor): number {
  return sessionsRepo.revokeAllSessionsForAccount(accountId, db)
}
