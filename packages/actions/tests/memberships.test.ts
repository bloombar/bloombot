/**
 * ENRL-5: `memberships.grant` — granted only by an existing owner, never on
 * the caller's own account, and recorded.
 */

import { accounts } from '@bloombot/db'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { grantMembershipAction } from '../src/actions/memberships.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganization } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('memberships.grant (ENRL-5)', () => {
  it('an owner grants a role, and the grant records who granted it', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const recipient = accounts.createAccount(
      organizationId,
      { email: 'recipient@example.edu', displayName: 'TA', role: 'assistant' },
      testDb.db
    )

    const granted = await dispatch(
      grantMembershipAction,
      { email: 'recipient@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    expect(granted).toMatchObject({
      accountId: recipient.id,
      role: 'instructor',
      grantedByAccountId: owner.id,
    })
  })

  it('refuses a caller who is not an owner', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'instructor@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )
    accounts.createAccount(
      organizationId,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'target@example.edu', role: 'owner' },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a caller granting a role to their own account', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'owner@example.edu', role: 'owner' },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses when dispatch was given no authenticated caller at all', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    accounts.createAccount(
      organizationId,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'target@example.edu', role: 'instructor' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses an owner in a different organization from the one being acted on', async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganization(testDb.db)
    const orgB = seedOrganization(testDb.db)
    const ownerOfA = accounts.createAccount(
      orgA,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )
    accounts.createAccount(
      orgB,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    // ownerOfA has no membership at all in orgB, so the "is the caller an
    // owner of *this* organization" check refuses them.
    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'target@example.edu', role: 'instructor' },
        { organizationId: orgB, db: testDb.db, accountId: ownerOfA.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses an email nobody holds an account under', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: `${randomUUID()}@example.edu`, role: 'instructor' },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})
