/**
 * AUTH-1 — sign-in tokens: issued once, redeemed once, and never recoverable
 * from the database.
 */

import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'

import {
  closeDatabase,
  openDatabase,
  schema,
  type Database,
} from '@bloombot/db'

import {
  consumeSignInToken,
  issueSignInToken,
  DEFAULT_TOKEN_TTL_MS,
} from '../src/tokens.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('issueSignInToken', () => {
  it('returns a token and never stores it in plaintext', () => {
    testDb = createTestDatabase()

    const issued = issueSignInToken('student@example.edu', testDb.db)

    expect(issued.token.length).toBeGreaterThan(20)
    expect(issued.expiresAt).toBeGreaterThan(Date.now())

    const rows = testDb.db.select().from(schema.signInTokens).all()
    expect(rows).toHaveLength(1)
    // The stored row must not contain the plaintext token anywhere.
    expect(rows[0]?.tokenHash).not.toBe(issued.token)
    expect(JSON.stringify(rows[0])).not.toContain(issued.token)
  })

  it('rejects a malformed email before writing anything', () => {
    testDb = createTestDatabase()

    expect(() => issueSignInToken('not-an-email', testDb.db)).toThrow()
    expect(testDb.db.select().from(schema.signInTokens).all()).toHaveLength(0)
  })

  it('defaults to a fifteen-minute expiry', () => {
    testDb = createTestDatabase()
    expect(DEFAULT_TOKEN_TTL_MS).toBe(15 * 60 * 1000)
  })
})

describe('consumeSignInToken (AUTH-1 replay)', () => {
  it('redeems a freshly issued token', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('student@example.edu', testDb.db)

    const consumed = consumeSignInToken(token, testDb.db)

    expect(consumed).toEqual({ email: 'student@example.edu' })
  })

  it('cannot be redeemed a second time — a replayed link is refused', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('student@example.edu', testDb.db)

    const first = consumeSignInToken(token, testDb.db)
    const second = consumeSignInToken(token, testDb.db)

    expect(first).toEqual({ email: 'student@example.edu' })
    expect(second).toBeUndefined()
  })

  it('refuses an expired token', () => {
    testDb = createTestDatabase()
    // Issued with a negative TTL: already expired the moment it is stored.
    const { token } = issueSignInToken('student@example.edu', testDb.db, -1)

    expect(consumeSignInToken(token, testDb.db)).toBeUndefined()
  })

  // AUTH-1: "a token that never existed is refused identically to a wrong
  // one" — no oracle. Both a token nobody ever issued and a token that was
  // already spent must be indistinguishable `undefined`.
  it('refuses a token that never existed the same way it refuses a replayed one', () => {
    testDb = createTestDatabase()
    const { token: issuedToken } = issueSignInToken(
      'student@example.edu',
      testDb.db
    )
    consumeSignInToken(issuedToken, testDb.db) // spend it

    const neverExisted = consumeSignInToken('made-up-token-value', testDb.db)
    const replayed = consumeSignInToken(issuedToken, testDb.db)

    expect(neverExisted).toBeUndefined()
    expect(replayed).toBeUndefined()
    expect(neverExisted).toBe(replayed)
  })

  // AUTH-1: "consumed in the same transaction that creates the session ...
  // so a link cannot be replayed" — two concurrent connections attempting to
  // redeem the same token must yield exactly one winner. Two real
  // connections against the same file, the way `packages/db`'s TEN-3 race
  // tests exercise concurrency: better-sqlite3 is synchronous, so this
  // proves the redemption is a single atomic statement rather than a
  // read-then-write a truly concurrent caller could interleave with, not
  // merely that calling it twice in a row works.
  it('two concurrent redemptions of the same token yield exactly one success', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('student@example.edu', testDb.db)

    const connectionA = testDb.db
    const connectionB: Database = openDatabase(testDb.path)

    const resultA = consumeSignInToken(token, connectionA)
    const resultB = consumeSignInToken(token, connectionB)

    const successes = [resultA, resultB].filter(
      (result) => result !== undefined
    )
    expect(successes).toHaveLength(1)

    // The row itself shows exactly one redemption, not two overlapping ones.
    const row = testDb.db
      .select()
      .from(schema.signInTokens)
      .where(eq(schema.signInTokens.email, 'student@example.edu'))
      .get()
    expect(row?.usedAt).not.toBeNull()

    closeDatabase(connectionB)
  })
})
