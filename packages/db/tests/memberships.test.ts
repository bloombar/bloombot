import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { accounts, memberships, organizations } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations and one account with a membership in each. */
function seedTwoOrganizationsWithOneAccountEach(testDatabase: TestDatabase) {
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

  const accountInA = accounts.createAccount(
    orgA,
    { email: 'a@example.edu', displayName: 'A', role: 'owner' },
    testDatabase.db
  )
  const accountInB = accounts.createAccount(
    orgB,
    { email: 'b@example.edu', displayName: 'B', role: 'owner' },
    testDatabase.db
  )

  return { orgA, orgB, accountInA, accountInB }
}

describe('memberships repo', () => {
  it('adds a second membership for an existing account (TEN-1)', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, accountInA } =
      seedTwoOrganizationsWithOneAccountEach(testDb)

    // accountInA joins orgB too, e.g. as a TA in a second course's org.
    memberships.createMembership(orgB, accountInA.id, 'assistant', testDb.db)

    expect(
      memberships.getMembership(orgA, accountInA.id, testDb.db)
    ).toBeDefined()
    expect(
      memberships.getMembership(orgB, accountInA.id, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })

  // TEN-2 / TEN-5: reading through the wrong organization looks like absence.
  it('does not return a membership through the wrong organization', () => {
    testDb = createTestDatabase()
    const { orgB, accountInA } = seedTwoOrganizationsWithOneAccountEach(testDb)

    expect(
      memberships.getMembership(orgB, accountInA.id, testDb.db)
    ).toBeUndefined()
  })

  it('lists only the memberships belonging to the given organization', () => {
    testDb = createTestDatabase()
    const { orgA, accountInA } = seedTwoOrganizationsWithOneAccountEach(testDb)

    const rows = memberships.listMembershipsForOrganization(orgA, testDb.db)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      organizationId: orgA,
      accountId: accountInA.id,
    })
  })

  // Must-fix 9 of the API-1..6 rework: `apps/api`'s `GET /auth/me` needs
  // every organization a signed-in caller belongs to, not just one it
  // already knows the id of — this is the account-keyed counterpart to
  // `listMembershipsForOrganization` above.
  it('lists every membership an account holds, across every organization it belongs to', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, accountInA } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    memberships.createMembership(orgB, accountInA.id, 'assistant', testDb.db)

    const rows = memberships.listMembershipsForAccount(accountInA.id, testDb.db)

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.organizationId).sort()).toEqual(
      [orgA, orgB].sort()
    )
  })

  it('lists nothing for an account with no memberships at all', () => {
    testDb = createTestDatabase()

    expect(
      memberships.listMembershipsForAccount(randomUUID(), testDb.db)
    ).toHaveLength(0)
  })

  it('updates a role scoped to its organization', () => {
    testDb = createTestDatabase()
    const { orgA, accountInA } = seedTwoOrganizationsWithOneAccountEach(testDb)

    const changed = memberships.updateMembershipRole(
      orgA,
      accountInA.id,
      'instructor',
      testDb.db
    )

    expect(changed).toBe(1)
    expect(
      memberships.getMembership(orgA, accountInA.id, testDb.db)
    ).toMatchObject({ role: 'instructor' })
  })

  // TEN-2: an update issued with the wrong organization id affects zero rows
  // rather than the other tenant's row.
  it('updating a role through the wrong organization affects zero rows', () => {
    testDb = createTestDatabase()
    const { orgB, accountInA } = seedTwoOrganizationsWithOneAccountEach(testDb)

    const changed = memberships.updateMembershipRole(
      orgB,
      accountInA.id,
      'instructor',
      testDb.db
    )

    expect(changed).toBe(0)
  })

  it('deletes a membership scoped to its organization', () => {
    testDb = createTestDatabase()
    const { orgA, accountInA } = seedTwoOrganizationsWithOneAccountEach(testDb)

    const changed = memberships.deleteMembership(orgA, accountInA.id, testDb.db)

    expect(changed).toBe(1)
    expect(
      memberships.getMembership(orgA, accountInA.id, testDb.db)
    ).toBeUndefined()
  })

  // TEN-2: a delete issued with the wrong organization id affects zero rows
  // rather than the other tenant's row.
  it('deleting through the wrong organization affects zero rows, leaving the real membership intact', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, accountInA } =
      seedTwoOrganizationsWithOneAccountEach(testDb)

    const changed = memberships.deleteMembership(orgB, accountInA.id, testDb.db)

    expect(changed).toBe(0)
    expect(
      memberships.getMembership(orgA, accountInA.id, testDb.db)
    ).toBeDefined()
  })
})
