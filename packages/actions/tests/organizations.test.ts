/**
 * WEB-57: `organizations.rename` — only an existing owner of *that*
 * organization may rename it; the trimmed, non-blank, non-over-long name is
 * what reads return afterward.
 */

import { accounts, organizations } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_ORGANIZATION_NAME_LENGTH,
  renameOrganizationAction,
} from '../src/actions/organizations.js'
import { dispatch } from '../src/dispatch.js'
import { ActionInputError, ActionRefusedError } from '../src/errors.js'
import { seedOrganization } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('organizations.rename (WEB-57)', () => {
  it('an owner renames, and the new name is what a later read returns', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db, 'Old Name')
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const renamed = await dispatch(
      renameOrganizationAction,
      { name: 'New Name' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )
    expect(renamed.name).toBe('New Name')

    // A later, independent read of the organization sees the new name too —
    // not merely the value this one call happened to echo back.
    const reread = organizations.getOrganizationById(organizationId, testDb.db)
    expect(reread?.name).toBe('New Name')
  })

  it('trims the name before storing it', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db, 'Old Name')
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const renamed = await dispatch(
      renameOrganizationAction,
      { name: '  Padded Name  ' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )
    expect(renamed.name).toBe('Padded Name')
  })

  it('refuses a non-owner (instructor)', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'i@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )

    await expect(
      dispatch(
        renameOrganizationAction,
        { name: 'New Name' },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a non-owner (assistant)', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'a@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        renameOrganizationAction,
        { name: 'New Name' },
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a caller who owns a different organization (TEN-5)', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db, 'Target Org')
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const otherOwner = accounts.createAccount(
      otherOrganizationId,
      { email: 'owner@other.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    // Dispatched *as though* acting in the target organization, but the
    // caller's own membership is only in the other one — the same
    // cross-tenant shape every other TEN-5 test in this package exercises.
    await expect(
      dispatch(
        renameOrganizationAction,
        { name: 'Hijacked Name' },
        { organizationId, db: testDb.db, accountId: otherOwner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a blank name', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        renameOrganizationAction,
        { name: '' },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionInputError)
  })

  it('refuses a whitespace-only name', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        renameOrganizationAction,
        { name: '   ' },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionInputError)
  })

  it('refuses an over-long name', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        renameOrganizationAction,
        { name: 'x'.repeat(MAX_ORGANIZATION_NAME_LENGTH + 1) },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionInputError)
  })
})
