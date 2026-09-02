import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, signInTokens } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('sign-in-tokens repo (AUTH-1)', () => {
  it('creates a token row and stores the hash, not any plaintext', () => {
    testDb = createTestDatabase()

    const row = signInTokens.createSignInToken(
      {
        email: 'Student@Example.edu',
        tokenHash: 'a-hash-value',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    expect(row).toMatchObject({
      email: 'student@example.edu',
      tokenHash: 'a-hash-value',
      usedAt: null,
    })
  })

  it('consumes a token exactly once', () => {
    testDb = createTestDatabase()
    signInTokens.createSignInToken(
      {
        email: 'a@example.edu',
        tokenHash: 'hash-1',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    const first = signInTokens.consumeSignInToken(
      'hash-1',
      Date.now(),
      testDb.db
    )
    const second = signInTokens.consumeSignInToken(
      'hash-1',
      Date.now(),
      testDb.db
    )

    expect(first).toMatchObject({ email: 'a@example.edu' })
    expect(second).toBeUndefined()
  })

  it('refuses a hash that was never issued', () => {
    testDb = createTestDatabase()
    expect(
      signInTokens.consumeSignInToken('nonexistent', Date.now(), testDb.db)
    ).toBeUndefined()
  })

  // AUTH-5's must-fix 1: `@bloombot/auth`'s `requestSignInLink` calls this
  // when the mail carrying a freshly issued token fails to send, so the
  // still-live row does not go on making `hasActiveSignInToken` refuse
  // every retry for the rest of the token's own lifetime.
  it('deletes an unused token row outright, unlike consuming it', () => {
    testDb = createTestDatabase()
    signInTokens.createSignInToken(
      {
        email: 'a@example.edu',
        tokenHash: 'hash-1',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    signInTokens.deleteSignInToken('hash-1', testDb.db)

    // Gone, not merely marked used — `hasActiveSignInToken` must see no
    // row at all, and a later `createSignInToken` for the same address
    // must not collide with a leftover one.
    expect(
      signInTokens.hasActiveSignInToken('a@example.edu', Date.now(), testDb.db)
    ).toBe(false)
    expect(
      signInTokens.consumeSignInToken('hash-1', Date.now(), testDb.db)
    ).toBeUndefined()
  })

  it('is a no-op for a hash that was never issued', () => {
    testDb = createTestDatabase()
    expect(() =>
      signInTokens.deleteSignInToken('nonexistent', testDb.db)
    ).not.toThrow()
  })

  it('refuses an expired token', () => {
    testDb = createTestDatabase()
    const now = Date.now()
    signInTokens.createSignInToken(
      { email: 'a@example.edu', tokenHash: 'hash-1', expiresAt: now - 1 },
      testDb.db
    )

    expect(
      signInTokens.consumeSignInToken('hash-1', now, testDb.db)
    ).toBeUndefined()
  })

  // TEN-3's re-claim guard proves the same shape with two connections; this
  // is that proof for the sign-in-token redemption's own single conditional
  // `UPDATE`.
  it('two connections redeeming the same hash yield exactly one winner', () => {
    testDb = createTestDatabase()
    const now = Date.now()
    signInTokens.createSignInToken(
      { email: 'a@example.edu', tokenHash: 'hash-1', expiresAt: now + 60_000 },
      testDb.db
    )

    const connectionB = openDatabase(testDb.path)
    const resultA = signInTokens.consumeSignInToken(
      'hash-1',
      Date.now(),
      testDb.db
    )
    const resultB = signInTokens.consumeSignInToken(
      'hash-1',
      Date.now(),
      connectionB
    )
    closeDatabase(connectionB)

    const successes = [resultA, resultB].filter((r) => r !== undefined)
    expect(successes).toHaveLength(1)
  })

  it('lowercases the email it stores, the same way accounts.ts does', () => {
    testDb = createTestDatabase()
    const id = randomUUID()

    const row = signInTokens.createSignInToken(
      {
        id,
        email: 'Mixed.Case@Example.EDU',
        tokenHash: 'hash-2',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    expect(row.email).toBe('mixed.case@example.edu')
  })

  // "Also worth doing" of the API-1..6 rework: the mailbox-flooding guard
  // `@bloombot/auth`'s `requestSignInLink` checks before issuing a second
  // token for the same address.
  describe('hasActiveSignInToken', () => {
    it('is false when no token has ever been issued for the address', () => {
      testDb = createTestDatabase()
      expect(
        signInTokens.hasActiveSignInToken(
          'nobody@example.edu',
          Date.now(),
          testDb.db
        )
      ).toBe(false)
    })

    it('is true while an unexpired, unused token exists', () => {
      testDb = createTestDatabase()
      signInTokens.createSignInToken(
        {
          email: 'student@example.edu',
          tokenHash: 'hash-active',
          expiresAt: Date.now() + 60_000,
        },
        testDb.db
      )

      expect(
        signInTokens.hasActiveSignInToken(
          'student@example.edu',
          Date.now(),
          testDb.db
        )
      ).toBe(true)
    })

    it('is case-insensitive on the address, the same way the rest of this repo is', () => {
      testDb = createTestDatabase()
      signInTokens.createSignInToken(
        {
          email: 'Student@Example.edu',
          tokenHash: 'hash-active',
          expiresAt: Date.now() + 60_000,
        },
        testDb.db
      )

      expect(
        signInTokens.hasActiveSignInToken(
          'student@EXAMPLE.edu',
          Date.now(),
          testDb.db
        )
      ).toBe(true)
    })

    it('is false once the outstanding token has been consumed', () => {
      testDb = createTestDatabase()
      signInTokens.createSignInToken(
        {
          email: 'student@example.edu',
          tokenHash: 'hash-consumed',
          expiresAt: Date.now() + 60_000,
        },
        testDb.db
      )
      signInTokens.consumeSignInToken('hash-consumed', Date.now(), testDb.db)

      expect(
        signInTokens.hasActiveSignInToken(
          'student@example.edu',
          Date.now(),
          testDb.db
        )
      ).toBe(false)
    })

    it('is false once the outstanding token has expired', () => {
      testDb = createTestDatabase()
      const now = Date.now()
      signInTokens.createSignInToken(
        {
          email: 'student@example.edu',
          tokenHash: 'hash-expired',
          expiresAt: now - 1,
        },
        testDb.db
      )

      expect(
        signInTokens.hasActiveSignInToken('student@example.edu', now, testDb.db)
      ).toBe(false)
    })
  })
})
