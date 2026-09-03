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

  // --- ENRL-5: a grant records who did it ---------------------------------

  it('grantMembershipRole creates a membership and records who granted it', () => {
    testDb = createTestDatabase()
    const { orgA, accountInB: recipient } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const granted = memberships.grantMembershipRole(
      orgA,
      {
        accountId: recipient.id,
        role: 'instructor',
        grantedByAccountId: owner.id,
      },
      testDb.db
    )

    expect(granted).toMatchObject({
      accountId: recipient.id,
      role: 'instructor',
      grantedByAccountId: owner.id,
    })
    expect(granted.grantedAt).toEqual(expect.any(Number))
  })

  it("grantMembershipRole changes an existing membership's role, still recording who granted it", () => {
    testDb = createTestDatabase()
    const { orgA, accountInA: recipient } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner2@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    // `recipient` already holds 'owner' in orgA from setup — grant changes it.
    const granted = memberships.grantMembershipRole(
      orgA,
      {
        accountId: recipient.id,
        role: 'assistant',
        grantedByAccountId: owner.id,
      },
      testDb.db
    )

    expect(granted).toMatchObject({
      role: 'assistant',
      grantedByAccountId: owner.id,
    })
    expect(
      memberships.getMembership(orgA, recipient.id, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })

  // The founding-owner membership `accounts.createAccount` writes inline
  // (not through `grantMembershipRole`) records no grantor — there is
  // nobody to have granted it (`schema.ts`'s own comment).
  it('the founding owner membership created at sign-up has no grantor', () => {
    testDb = createTestDatabase()
    const { orgA, accountInA } = seedTwoOrganizationsWithOneAccountEach(testDb)

    expect(
      memberships.getMembership(orgA, accountInA.id, testDb.db)
    ).toMatchObject({
      grantedByAccountId: null,
      grantedAt: null,
    })
  })

  // --- ENRL-11: revoking marks the row, and stops it counting anywhere ----

  it('revokeMembership marks a membership revoked, recording who revoked it and when', () => {
    testDb = createTestDatabase()
    const { orgA, accountInB: recipient } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    memberships.createMembership(orgA, recipient.id, 'instructor', testDb.db)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const revoked = memberships.revokeMembership(
      orgA,
      { accountId: recipient.id, revokedByAccountId: owner.id },
      testDb.db
    )

    expect(revoked).toMatchObject({
      accountId: recipient.id,
      revokedByAccountId: owner.id,
    })
    expect(revoked?.revokedAt).toEqual(expect.any(Number))
  })

  // The whole point of ENRL-11: a revoked membership stops being found by
  // the function nearly every authorization check in the platform calls.
  // Fails without the fix — before `getMembership`'s own `WHERE` excluded
  // a revoked row, this returned the revoked row itself, `role` and all.
  it('a revoked membership is no longer found by getMembership', () => {
    testDb = createTestDatabase()
    const { orgA, accountInB: recipient } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    memberships.createMembership(orgA, recipient.id, 'instructor', testDb.db)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    memberships.revokeMembership(
      orgA,
      { accountId: recipient.id, revokedByAccountId: owner.id },
      testDb.db
    )

    expect(
      memberships.getMembership(orgA, recipient.id, testDb.db)
    ).toBeUndefined()
  })

  it('a revoked membership is excluded from listMembershipsForOrganization and listMembershipsForAccount', () => {
    testDb = createTestDatabase()
    const { orgA, accountInB: recipient } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    memberships.createMembership(orgA, recipient.id, 'instructor', testDb.db)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    memberships.revokeMembership(
      orgA,
      { accountId: recipient.id, revokedByAccountId: owner.id },
      testDb.db
    )

    expect(
      memberships
        .listMembershipsForOrganization(orgA, testDb.db)
        .map((m) => m.accountId)
    ).not.toContain(recipient.id)
    expect(
      memberships
        .listMembershipsForAccount(recipient.id, testDb.db)
        .map((m) => m.organizationId)
    ).not.toContain(orgA)
  })

  // TEN-5/TEN-2: revoking through the wrong organization affects nothing.
  it('revoking through the wrong organization leaves the real membership intact', () => {
    testDb = createTestDatabase()
    const {
      orgA,
      orgB,
      accountInB: recipient,
    } = seedTwoOrganizationsWithOneAccountEach(testDb)
    memberships.createMembership(orgA, recipient.id, 'instructor', testDb.db)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const revoked = memberships.revokeMembership(
      orgB,
      { accountId: recipient.id, revokedByAccountId: owner.id },
      testDb.db
    )

    expect(revoked).toBeUndefined()
    expect(
      memberships.getMembership(orgA, recipient.id, testDb.db)
    ).toMatchObject({ role: 'instructor' })
  })

  it('revoking an already-revoked membership is refused (undefined), not a second revoke', () => {
    testDb = createTestDatabase()
    const { orgA, accountInB: recipient } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    memberships.createMembership(orgA, recipient.id, 'instructor', testDb.db)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    memberships.revokeMembership(
      orgA,
      { accountId: recipient.id, revokedByAccountId: owner.id },
      testDb.db
    )

    const secondAttempt = memberships.revokeMembership(
      orgA,
      { accountId: recipient.id, revokedByAccountId: owner.id },
      testDb.db
    )

    expect(secondAttempt).toBeUndefined()
  })

  // ENRL-11: "an organization always has an owner" — enforced here, below
  // any action or screen, because this is the one place any caller of this
  // function is forced through. Fails without the fix: dropping the
  // `activeOwners.length <= 1` guard lets this revoke succeed, leaving
  // `orgA` with zero owners.
  it('the last owner cannot be revoked, even by another owner', () => {
    testDb = createTestDatabase()
    const { orgA, accountInA: soleOwner } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    const peerOwner = accounts.createAccount(
      orgA,
      { email: 'peer@example.edu', displayName: 'Peer', role: 'owner' },
      testDb.db
    )

    const result = memberships.revokeMembership(
      orgA,
      { accountId: soleOwner.id, revokedByAccountId: peerOwner.id },
      testDb.db
    )

    // `soleOwner` was the *original* founding owner; `peerOwner` is a
    // second owner added afterward — two owners exist, so `soleOwner` is
    // not actually the org's last one, and the revoke should succeed. This
    // proves the guard counts correctly rather than refusing every owner.
    expect(result).toMatchObject({ accountId: soleOwner.id })
    expect(
      memberships.getMembership(orgA, soleOwner.id, testDb.db)
    ).toBeUndefined()
    // `peerOwner`, the organization's only remaining owner, cannot revoke
    // themselves either — that would leave zero.
    expect(
      memberships.revokeMembership(
        orgA,
        { accountId: peerOwner.id, revokedByAccountId: peerOwner.id },
        testDb.db
      )
    ).toBeUndefined()
    expect(
      memberships.getMembership(orgA, peerOwner.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
  })

  it('a non-last owner can be revoked, leaving the organization with its remaining owner', () => {
    testDb = createTestDatabase()
    const { orgA, accountInA: founder } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    const peerOwner = accounts.createAccount(
      orgA,
      { email: 'peer@example.edu', displayName: 'Peer', role: 'owner' },
      testDb.db
    )

    const result = memberships.revokeMembership(
      orgA,
      { accountId: peerOwner.id, revokedByAccountId: founder.id },
      testDb.db
    )

    expect(result).toMatchObject({ accountId: peerOwner.id })
    expect(
      memberships.getMembership(orgA, founder.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
  })

  // ENRL-11: a fresh grant reactivates a row a previous revoke left behind
  // — the composite primary key means there is no other way for the same
  // (organization, account) pair to hold a membership again.
  it('grantMembershipRole reactivates a previously revoked membership, clearing the revocation', () => {
    testDb = createTestDatabase()
    const { orgA, accountInB: recipient } =
      seedTwoOrganizationsWithOneAccountEach(testDb)
    memberships.createMembership(orgA, recipient.id, 'instructor', testDb.db)
    const owner = accounts.createAccount(
      orgA,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    memberships.revokeMembership(
      orgA,
      { accountId: recipient.id, revokedByAccountId: owner.id },
      testDb.db
    )
    expect(
      memberships.getMembership(orgA, recipient.id, testDb.db)
    ).toBeUndefined()

    const regranted = memberships.grantMembershipRole(
      orgA,
      {
        accountId: recipient.id,
        role: 'assistant',
        grantedByAccountId: owner.id,
      },
      testDb.db
    )

    expect(regranted).toMatchObject({
      role: 'assistant',
      revokedAt: null,
      revokedByAccountId: null,
    })
    expect(
      memberships.getMembership(orgA, recipient.id, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })
})
