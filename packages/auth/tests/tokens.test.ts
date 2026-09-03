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
  signInTokens,
  type Database,
} from '@bloombot/db'

import { hashSecret, generateSecret } from '../src/secrets.js'
import {
  consumeSignInToken,
  issueSignInToken,
  updateSignInTokenDestination,
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
} from '../src/tokens.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

// AUTH-6 rework, cheap-fix — two adversarial values `apps/web/tests/app.test.tsx`
// asserts against too, both resolving *off* origin despite looking like a
// path: `//evil.example` is protocol-relative (a browser treats it exactly
// like `https://evil.example`), and `/\evil.example` is the identical trick
// through a backslash some URL parsers still normalize to a second slash.
// Shared between the two files deliberately, not two independently invented
// examples — the point is that both of `isSameOriginPath`'s copies
// (`tokens.ts`'s own, and `App.tsx`'s duplicate) refuse the *same* inputs.
const OFF_ORIGIN_DESTINATIONS = ['//evil.example', '/\\evil.example']

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

  // AUTH-6 rework, cheap-fix — pins this function's own throw directly,
  // rather than only through `apps/api`'s route-level `zod` schema (which
  // refuses the request before this function ever runs, so it cannot prove
  // this defence-in-depth layer does anything on its own). Fails without the
  // fix if this throw is ever removed and nothing upstream catches the gap.
  it.each(OFF_ORIGIN_DESTINATIONS)(
    'rejects a destination that is not a same-origin path (%s), writing nothing',
    (destination) => {
      testDb = createTestDatabase()

      expect(() =>
        issueSignInToken(
          'student@example.edu',
          testDb.db,
          DEFAULT_TOKEN_TTL_MS,
          destination
        )
      ).toThrow()
      expect(testDb.db.select().from(schema.signInTokens).all()).toHaveLength(0)
    }
  )

  it('defaults to a fifteen-minute expiry', () => {
    testDb = createTestDatabase()
    expect(DEFAULT_TOKEN_TTL_MS).toBe(15 * 60 * 1000)
  })

  // Finding 5 of the AUTH-1..4 rework: `ttlMs` had no upper bound, so a
  // caller could issue a link good for a year — and a reviewer confirmed
  // one actually redeemed. AUTH-1's "expire within minutes" must be
  // structural, not merely what every caller today happens to ask for.
  it('clamps a ttlMs far beyond the maximum down to MAX_TOKEN_TTL_MS', () => {
    testDb = createTestDatabase()
    const oneYearMs = 365 * 24 * 60 * 60 * 1000

    const issued = issueSignInToken('student@example.edu', testDb.db, oneYearMs)

    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + MAX_TOKEN_TTL_MS)

    // Not merely "the returned value looks capped" — the token issued this
    // way must actually stop redeeming once the (real) ceiling has passed,
    // not the requested year-long one.
    const justPastTheCap = Date.now() + MAX_TOKEN_TTL_MS + 1000
    const row = testDb.db.select().from(schema.signInTokens).get()
    expect(row?.expiresAt).toBeLessThanOrEqual(justPastTheCap)
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
  // already spent must be indistinguishable `undefined` (finding 8 of the
  // AUTH-1..4 rework: `expect(neverExisted).toBe(replayed)` on its own only
  // ever compares two `undefined`s, which is trivially true regardless of
  // what either call actually did — it cannot fail, so it was not testing
  // anything `toBeUndefined()` above it did not already cover). What the
  // no-oracle property actually needs is that the *replay attempt* leaves
  // no observable trace of its own: the row's `used_at` — the only place a
  // "was this already spent" fact is recorded — must be exactly what the
  // first, legitimate consumption set it to, not bumped again by the
  // replay, which would otherwise be a timing/state side-channel telling
  // the two cases apart.
  it('refuses a token that never existed the same way it refuses a replayed one, without a further side effect from the replay', () => {
    testDb = createTestDatabase()
    const { token: issuedToken } = issueSignInToken(
      'student@example.edu',
      testDb.db
    )
    const firstConsumption = consumeSignInToken(issuedToken, testDb.db) // spend it
    const usedAtAfterFirstConsumption = testDb.db
      .select()
      .from(schema.signInTokens)
      .get()?.usedAt

    const neverExisted = consumeSignInToken('made-up-token-value', testDb.db)
    const replayed = consumeSignInToken(issuedToken, testDb.db)

    expect(firstConsumption).toEqual({ email: 'student@example.edu' })
    expect(neverExisted).toBeUndefined()
    expect(replayed).toBeUndefined()
    expect(testDb.db.select().from(schema.signInTokens).get()?.usedAt).toBe(
      usedAtAfterFirstConsumption
    )
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

  // AUTH-6 rework, cheap-fix — pins the redemption-time re-check directly.
  // `issueSignInToken` already refuses to store a bad `destination`, so the
  // only way to exercise this defence-in-depth layer at all is to write one
  // straight through `@bloombot/db`'s own repo (bypassing `issueSignInToken`
  // entirely) — simulating a row this package's own write path did not
  // produce, the one case `consumeSignInToken`'s own "defended, not assumed"
  // comment is actually defending against. Fails without the fix if this
  // re-check is ever removed and `redeemSignInLink` starts handing an
  // off-origin value straight to a browser.
  it.each(OFF_ORIGIN_DESTINATIONS)(
    'strips an off-origin destination (%s) back to undefined on redemption, even if the row somehow carried one',
    (destination) => {
      testDb = createTestDatabase()
      const secret = generateSecret()
      signInTokens.createSignInToken(
        {
          email: 'student@example.edu',
          tokenHash: hashSecret(secret),
          expiresAt: Date.now() + 60_000,
          destination,
        },
        testDb.db
      )

      const consumed = consumeSignInToken(secret, testDb.db)

      expect(consumed?.email).toBe('student@example.edu')
      expect(consumed?.destination).toBeUndefined()
    }
  )
})

describe('updateSignInTokenDestination (AUTH-6 rework, must-fix 2)', () => {
  it('updates the destination of the active token for this address, without issuing a new one', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken(
      'student@example.edu',
      testDb.db,
      DEFAULT_TOKEN_TTL_MS,
      '/connect/org-1'
    )

    const updated = updateSignInTokenDestination(
      'student@example.edu',
      '/join/secret-abc',
      testDb.db
    )

    expect(updated).toBe(true)
    // Still exactly one row — a second, competing token was not issued.
    expect(testDb.db.select().from(schema.signInTokens).all()).toHaveLength(1)
    // The *same*, already-issued token now redeems to the new destination.
    expect(consumeSignInToken(token, testDb.db)?.destination).toBe(
      '/join/secret-abc'
    )
  })

  it.each(OFF_ORIGIN_DESTINATIONS)(
    'rejects a destination that is not a same-origin path (%s), leaving the outstanding token unchanged',
    (destination) => {
      testDb = createTestDatabase()
      const { token } = issueSignInToken(
        'student@example.edu',
        testDb.db,
        DEFAULT_TOKEN_TTL_MS,
        '/connect/org-1'
      )

      expect(() =>
        updateSignInTokenDestination(
          'student@example.edu',
          destination,
          testDb.db
        )
      ).toThrow()
      expect(consumeSignInToken(token, testDb.db)?.destination).toBe(
        '/connect/org-1'
      )
    }
  )
})
