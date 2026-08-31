import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { accounts, organizations } from '@bloombot/db'

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

  it('disables an account scoped to the organization it belongs to', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const account = accounts.createAccount(
      orgA,
      { email: 'to-disable@example.edu', displayName: 'X', role: 'owner' },
      testDb.db
    )

    const changed = accounts.disableAccountInOrganization(
      orgA,
      account.id,
      testDb.db
    )

    expect(changed).toBe(1)
    expect(
      accounts.getAccountInOrganization(orgA, account.id, testDb.db)?.disabledAt
    ).not.toBeNull()
  })

  // TEN-2: a write through the wrong organization id affects zero rows,
  // not the other tenant's row.
  it('disabling through the wrong organization affects zero rows', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    const account = accounts.createAccount(
      orgA,
      { email: 'protected@example.edu', displayName: 'X', role: 'owner' },
      testDb.db
    )

    const changed = accounts.disableAccountInOrganization(
      orgB,
      account.id,
      testDb.db
    )

    expect(changed).toBe(0)
    expect(
      accounts.getAccountInOrganization(orgA, account.id, testDb.db)?.disabledAt
    ).toBeNull()
  })
})
