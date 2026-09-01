/**
 * AUTH-3 — sessions: create, validate, rotate and revoke, all through
 * hashes so a stolen row cannot be replayed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { schema } from '@bloombot/db'

import {
  createSession,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  validateSession,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_AGE_MS,
} from '../src/sessions.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
  vi.useRealTimers()
})

/** One account for a session to belong to. Synthetic, minimal — this suite does not exercise sign-in itself. */
function seedAccount(db: TestDatabase['db']): string {
  const accountId = crypto.randomUUID()
  db.insert(schema.accounts)
    .values({
      id: accountId,
      email: 'instructor@example.edu',
      displayName: 'Instructor',
      createdAt: Date.now(),
    })
    .run()
  return accountId
}

describe('createSession', () => {
  it('returns a token and never stores it in plaintext', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)

    const created = createSession(accountId, testDb.db)

    expect(created.token.length).toBeGreaterThan(20)
    expect(created.accountId).toBe(accountId)

    const rows = testDb.db.select().from(schema.sessions).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tokenHash).not.toBe(created.token)
    expect(JSON.stringify(rows[0])).not.toContain(created.token)
  })

  it('defaults to a thirty-day expiry', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})

describe('validateSession (AUTH-3)', () => {
  it('validates before expiry', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    const { token } = createSession(accountId, testDb.db)

    expect(validateSession(token, testDb.db)).toMatchObject({ accountId })
  })

  it('does not validate after expiry', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    // Negative TTL: already expired the moment it is stored.
    const { token } = createSession(accountId, testDb.db, -1)

    expect(validateSession(token, testDb.db)).toBeUndefined()
  })

  it('does not validate a token that was never issued', () => {
    testDb = createTestDatabase()
    expect(validateSession('made-up-session-token', testDb.db)).toBeUndefined()
  })

  it('touches lastSeenAt on a successful validation', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    const { token } = createSession(accountId, testDb.db)
    const before = testDb.db.select().from(schema.sessions).get()

    vi.useFakeTimers()
    vi.setSystemTime(new Date((before?.lastSeenAt ?? 0) + 60_000))
    validateSession(token, testDb.db)
    vi.useRealTimers()

    const after = testDb.db.select().from(schema.sessions).get()
    expect(after?.lastSeenAt).toBeGreaterThan(before?.lastSeenAt ?? 0)
  })
})

describe('rotateSession (AUTH-3)', () => {
  it('invalidates the old token and issues a working new one', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    const { token: oldToken } = createSession(accountId, testDb.db)

    const rotated = rotateSession(oldToken, testDb.db)

    expect(rotated).toBeDefined()
    expect(rotated?.token).not.toBe(oldToken)
    expect(validateSession(oldToken, testDb.db)).toBeUndefined()
    expect(validateSession(rotated!.token, testDb.db)).toMatchObject({
      accountId,
    })
  })

  it('refuses to rotate an already-revoked session', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    const { token } = createSession(accountId, testDb.db)
    revokeSession(token, testDb.db)

    expect(rotateSession(token, testDb.db)).toBeUndefined()
  })

  // Finding 1 of the AUTH-1..4 rework: an expired token must not be
  // rotatable into a live one — without the fix, `revokeSessionByHash`
  // reported an expired session as successfully revoked, and `rotateSession`
  // read that as proof the session was still active, minting a fresh
  // thirty-day session for a token that had been dead for months.
  it('refuses to rotate an already-expired session, and does not revive it', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    // Negative TTL: already expired the moment it is stored.
    const { token } = createSession(accountId, testDb.db, -1)

    expect(rotateSession(token, testDb.db)).toBeUndefined()
    // Not merely "no new session" — the caller must not be able to sign in
    // as this account through this token by any other route either.
    expect(validateSession(token, testDb.db)).toBeUndefined()
  })

  // Finding 1's belt-and-braces half: a chain of rotations carries the
  // *original* session's `createdAt` forward, and once that chain is older
  // than `MAX_SESSION_AGE_MS`, rotation refuses rather than extending it
  // again — repeated rotation must not keep a session alive forever.
  it('refuses to rotate a session whose chain is older than MAX_SESSION_AGE_MS, ending it rather than reviving it', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)

    vi.useFakeTimers()
    const chainStart = new Date('2020-01-01T00:00:00Z')
    vi.setSystemTime(chainStart)
    const { token: firstToken } = createSession(accountId, testDb.db)

    // Still well within the cap: one ordinary rotation succeeds and keeps
    // the chain's original `createdAt`.
    vi.setSystemTime(new Date(chainStart.getTime() + 1000))
    const rotatedOnce = rotateSession(firstToken, testDb.db)
    expect(rotatedOnce).toBeDefined()

    // Past the cap: this rotation must refuse rather than mint yet another
    // thirty-day session on top of a chain this old.
    vi.setSystemTime(new Date(chainStart.getTime() + MAX_SESSION_AGE_MS + 1))
    const rotatedPastCap = rotateSession(rotatedOnce!.token, testDb.db)
    expect(rotatedPastCap).toBeUndefined()

    // The token presented past the cap is dead either way — refusing to
    // extend the chain also ends it, rather than leaving it rotatable
    // again on the next attempt.
    expect(validateSession(rotatedOnce!.token, testDb.db)).toBeUndefined()

    vi.useRealTimers()
  })
})

describe('revokeSession / revokeAllSessions (AUTH-3)', () => {
  it('revoking one session leaves the account other sessions alive', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    const sessionA = createSession(accountId, testDb.db)
    const sessionB = createSession(accountId, testDb.db)

    expect(revokeSession(sessionA.token, testDb.db)).toBe(true)

    expect(validateSession(sessionA.token, testDb.db)).toBeUndefined()
    expect(validateSession(sessionB.token, testDb.db)).toMatchObject({
      accountId,
    })
  })

  it('revoking a session that does not exist reports no-op, not an error', () => {
    testDb = createTestDatabase()
    expect(revokeSession('made-up-session-token', testDb.db)).toBe(false)
  })

  // Finding 1 of the AUTH-1..4 rework: revoking an already-expired session
  // must report the same "nothing to do" as one that never existed, not
  // "an active session just ended".
  it('revoking an already-expired session reports no-op, not "an active session just ended"', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    // Negative TTL: already expired the moment it is stored.
    const { token } = createSession(accountId, testDb.db, -1)

    expect(revokeSession(token, testDb.db)).toBe(false)
  })

  it('revokeAllSessions kills every session of an account', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    const sessionA = createSession(accountId, testDb.db)
    const sessionB = createSession(accountId, testDb.db)

    const revokedCount = revokeAllSessions(accountId, testDb.db)

    expect(revokedCount).toBe(2)
    expect(validateSession(sessionA.token, testDb.db)).toBeUndefined()
    expect(validateSession(sessionB.token, testDb.db)).toBeUndefined()
  })

  it('revokeAllSessions does not touch a different account session', () => {
    testDb = createTestDatabase()
    const accountA = seedAccount(testDb.db)
    const accountB = crypto.randomUUID()
    testDb.db
      .insert(schema.accounts)
      .values({
        id: accountB,
        email: 'other@example.edu',
        displayName: 'Other',
        createdAt: Date.now(),
      })
      .run()

    const sessionA = createSession(accountA, testDb.db)
    const sessionB = createSession(accountB, testDb.db)

    revokeAllSessions(accountA, testDb.db)

    expect(validateSession(sessionA.token, testDb.db)).toBeUndefined()
    expect(validateSession(sessionB.token, testDb.db)).toMatchObject({
      accountId: accountB,
    })
  })
})
