import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { accounts, organizations, sessions } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, for the tests that prove tenant scoping (TEN-2). */
function seedTwoOrganizations(testDatabase: TestDatabase) {
  const orgA = randomUUID()
  const orgB = randomUUID()
  organizations.createOrganization(
    orgA,
    { name: 'Org A', isPersonal: false },
    testDatabase.db
  )
  organizations.createOrganization(
    orgB,
    { name: 'Org B', isPersonal: false },
    testDatabase.db
  )
  return { orgA, orgB }
}

describe('accounts repo', () => {
  it('looks up an account by email, unscoped (TEN-2 exception #1)', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    accounts.createAccount(
      orgA,
      { email: 'Jane@Example.edu', displayName: 'Jane', role: 'owner' },
      testDb.db
    )

    // Stored lowercased; looked up case-insensitively either way.
    expect(
      accounts.getAccountByEmail('jane@example.edu', testDb.db)
    ).toMatchObject({ email: 'jane@example.edu' })
    expect(
      accounts.getAccountByEmail('Jane@Example.edu', testDb.db)
    ).toMatchObject({ email: 'jane@example.edu' })
  })

  it('returns undefined for an email with no account', () => {
    testDb = createTestDatabase()

    expect(
      accounts.getAccountByEmail('nobody@example.edu', testDb.db)
    ).toBeUndefined()
  })

  it('creates an account with a membership in the given organization', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const account = accounts.createAccount(
      orgA,
      { email: 'ta@example.edu', displayName: 'TA', role: 'assistant' },
      testDb.db
    )

    expect(
      accounts.getAccountInOrganization(orgA, account.id, testDb.db)
    ).toMatchObject({ id: account.id, email: 'ta@example.edu' })
  })

  // TEN-2: reading through the wrong organization must not return another
  // tenant's record.
  it('does not return an account through an organization it is not a member of', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    const account = accounts.createAccount(
      orgA,
      { email: 'only-a@example.edu', displayName: 'Only A', role: 'owner' },
      testDb.db
    )

    // TEN-5: absence, not a different error, for the wrong organization.
    expect(
      accounts.getAccountInOrganization(orgB, account.id, testDb.db)
    ).toBeUndefined()
    // ...and the record is still reachable through the right one.
    expect(
      accounts.getAccountInOrganization(orgA, account.id, testDb.db)
    ).toBeDefined()
  })

  it('returns undefined for an account id that does not exist at all', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    expect(
      accounts.getAccountInOrganization(orgA, randomUUID(), testDb.db)
    ).toBeUndefined()
  })

  // Proves `createAccount`'s `db.transaction(...)` wrapper is real: the
  // membership insert fails its foreign key (no such organization), and
  // without the transaction the preceding account insert would survive it,
  // leaving an orphan row holding the email hostage.
  it('leaves no orphan account row when the membership insert fails', () => {
    testDb = createTestDatabase()

    expect(() =>
      accounts.createAccount(
        randomUUID(), // no organization with this id exists
        { email: 'orphan@example.edu', displayName: 'Orphan', role: 'owner' },
        testDb.db
      )
    ).toThrow()

    expect(
      accounts.getAccountByEmail('orphan@example.edu', testDb.db)
    ).toBeUndefined()
  })

  // Finding 3 of the AUTH-1..4 rework: disabling and revocation are one
  // operation, so a caller cannot set `disabled_at` without also ending
  // every session already open on the account.
  describe('disableAccount', () => {
    it('sets disabledAt and revokes every session the account holds', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      const account = accounts.createAccount(
        orgA,
        { email: 'suspect@example.edu', displayName: 'Suspect', role: 'owner' },
        testDb.db
      )
      sessions.createSession(
        {
          accountId: account.id,
          tokenHash: 'hash-1',
          expiresAt: Date.now() + 60_000,
        },
        testDb.db
      )
      sessions.createSession(
        {
          accountId: account.id,
          tokenHash: 'hash-2',
          expiresAt: Date.now() + 60_000,
        },
        testDb.db
      )

      const disabled = accounts.disableAccount(account.id, testDb.db)

      expect(disabled?.disabledAt).not.toBeNull()
      expect(
        sessions.validateSession('hash-1', Date.now(), testDb.db)
      ).toBeUndefined()
      expect(
        sessions.validateSession('hash-2', Date.now(), testDb.db)
      ).toBeUndefined()
    })

    it('does not disable — or touch any session of — a different account', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      const untouched = accounts.createAccount(
        orgA,
        {
          email: 'untouched@example.edu',
          displayName: 'Untouched',
          role: 'owner',
        },
        testDb.db
      )
      sessions.createSession(
        {
          accountId: untouched.id,
          tokenHash: 'hash-untouched',
          expiresAt: Date.now() + 60_000,
        },
        testDb.db
      )

      accounts.disableAccount(randomUUID(), testDb.db)

      expect(
        accounts.getAccountByEmail('untouched@example.edu', testDb.db)
      ).toMatchObject({ disabledAt: null })
      expect(
        sessions.validateSession('hash-untouched', Date.now(), testDb.db)
      ).toMatchObject({ accountId: untouched.id })
    })

    it('returns undefined for an account id that does not exist', () => {
      testDb = createTestDatabase()

      expect(accounts.disableAccount(randomUUID(), testDb.db)).toBeUndefined()
    })
  })
})
