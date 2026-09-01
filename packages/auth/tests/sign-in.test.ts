/**
 * The sign-in flows, end to end against a real (throwaway) database:
 * AUTH-1's redemption, AUTH-2's Google linking rule, and TEN-1's atomic
 * "account, personal organization and membership together, or none of
 * them".
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { accounts, organizations, schema } from '@bloombot/db'

import type { GoogleIdentity } from '../src/link.js'
import { redeemSignInLink, signInWithGoogle } from '../src/sign-in.js'
import { issueSignInToken } from '../src/tokens.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('redeemSignInLink (AUTH-1, TEN-1)', () => {
  it('creates the account, its personal organization and its membership, atomically, on a first-time sign-in', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('new.instructor@example.edu', testDb.db)

    const result = redeemSignInLink(token, testDb.db)

    expect(result).toBeDefined()
    expect(result?.createdAccount).toBe(true)
    expect(result?.account.email).toBe('new.instructor@example.edu')

    // A membership row exists for this account, with the `owner` role
    // TEN-1's personal organization grants a first-time sign-in.
    const membershipRows = testDb.db.select().from(schema.memberships).all()
    expect(membershipRows).toHaveLength(1)
    expect(membershipRows[0]).toMatchObject({
      accountId: result?.account.id,
      role: 'owner',
    })

    // And the organization it names is a fresh, personal one.
    const organizationRow = organizations.getOrganizationById(
      membershipRows[0]!.organizationId,
      testDb.db
    )
    expect(organizationRow).toMatchObject({ isPersonal: true })
  })

  it('does not create a second account for a returning sign-in', () => {
    testDb = createTestDatabase()
    const first = issueSignInToken('returning@example.edu', testDb.db)
    const firstResult = redeemSignInLink(first.token, testDb.db)

    const second = issueSignInToken('returning@example.edu', testDb.db)
    const secondResult = redeemSignInLink(second.token, testDb.db)

    expect(secondResult?.createdAccount).toBe(false)
    expect(secondResult?.account.id).toBe(firstResult?.account.id)
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(1)
  })

  it('returns undefined for an invalid token without creating anything', () => {
    testDb = createTestDatabase()

    const result = redeemSignInLink('never-issued', testDb.db)

    expect(result).toBeUndefined()
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(0)
  })

  // TEN-1: "a failure part-way leaves none of the three [account,
  // organization, membership]." Forces the failure the same way
  // `packages/db`'s own `accounts.test.ts` does for `createAccount` alone —
  // here the id `crypto.randomUUID()` hands back for the *account* row is
  // made to collide with an already-existing, unrelated account, so the
  // account insert fails on its primary key after the organization insert
  // ahead of it has already succeeded. If the three writes were not one
  // transaction, the organization row would survive this; asserting it does
  // not is the actual proof.
  it('a failure creating the account rolls back the organization it already created', () => {
    testDb = createTestDatabase()
    const collidingAccountId = accounts.createAccount(
      organizations.createOrganization(
        crypto.randomUUID(),
        { name: 'Unrelated', isPersonal: false },
        testDb.db
      ).id,
      {
        email: 'unrelated@example.edu',
        displayName: 'Unrelated',
        role: 'owner',
      },
      testDb.db
    ).id

    const { token } = issueSignInToken('first-timer@example.edu', testDb.db)

    const orgIdForThisSignIn = crypto.randomUUID()
    const randomUUIDSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      // 1st call: the personal organization's id — succeeds.
      .mockReturnValueOnce(
        orgIdForThisSignIn as `${string}-${string}-${string}-${string}-${string}`
      )
      // 2nd call: the account's id — collides with the account seeded above,
      // so this insert fails its primary key.
      .mockReturnValueOnce(
        collidingAccountId as `${string}-${string}-${string}-${string}-${string}`
      )

    expect(() => redeemSignInLink(token, testDb.db)).toThrow()
    randomUUIDSpy.mockRestore()

    // The organization created just before the failing account insert must
    // not have survived — same transaction, same rollback.
    expect(
      organizations.getOrganizationById(orgIdForThisSignIn, testDb.db)
    ).toBeUndefined()
    // Nor a second membership under it.
    expect(
      testDb.db
        .select()
        .from(schema.memberships)
        .all()
        .filter((row) => row.organizationId === orgIdForThisSignIn)
    ).toHaveLength(0)
    // The token itself must not have been left "used" by a sign-in that
    // never completed — AUTH-1's own redemption is inside the same rolled-
    // back transaction.
    const tokenRow = testDb.db.select().from(schema.signInTokens).get()
    expect(tokenRow?.usedAt).toBeNull()
  })
})

function verifiedGoogleIdentity(
  overrides: Partial<GoogleIdentity> = {}
): GoogleIdentity {
  return {
    subject: 'google-subject-1',
    email: 'person@example.edu',
    emailVerified: true,
    ...overrides,
  }
}

describe('signInWithGoogle (AUTH-2)', () => {
  it('links to an existing account when the email is verified and matches', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('person@example.edu', testDb.db)
    const existing = redeemSignInLink(token, testDb.db)

    const result = signInWithGoogle(
      verifiedGoogleIdentity({ email: 'person@example.edu' }),
      testDb.db
    )

    expect(result?.createdAccount).toBe(false)
    expect(result?.account.id).toBe(existing?.account.id)
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(1)
  })

  it('creates a new account when the email is verified but matches nobody', () => {
    testDb = createTestDatabase()

    const result = signInWithGoogle(
      verifiedGoogleIdentity({ email: 'brand-new@example.edu' }),
      testDb.db
    )

    expect(result?.createdAccount).toBe(true)
    expect(result?.account.email).toBe('brand-new@example.edu')
    const membershipRows = testDb.db.select().from(schema.memberships).all()
    expect(membershipRows).toHaveLength(1)
  })

  // AUTH-2's own attack sentence, exercised end to end: an unverified email
  // that matches an existing account must never sign the caller into that
  // account. Because `accounts.email` is unique, the "create a new account"
  // side of the rule cannot literally reuse that email string — the
  // documented, deliberate outcome here is a clean refusal, not a linked
  // session and not a crash. See docs/DECISIONS.md.
  it('refuses to sign in — and never links — when the email matches an existing account but is not verified', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('victim@example.edu', testDb.db)
    const victim = redeemSignInLink(token, testDb.db)

    const result = signInWithGoogle(
      verifiedGoogleIdentity({
        email: 'victim@example.edu',
        emailVerified: false,
      }),
      testDb.db
    )

    expect(result).toBeUndefined()
    // The victim's account is untouched: still exactly one account, one
    // session (the one from the legitimate redemption above) — the attempt
    // above created neither a second account nor a session for the first.
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(1)
    const sessionRows = testDb.db.select().from(schema.sessions).all()
    expect(sessionRows).toHaveLength(1)
    expect(sessionRows[0]?.accountId).toBe(victim?.account.id)
  })
})
