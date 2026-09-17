import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { organizations } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('organizations repo', () => {
  it('creates an organization with the given id and reads it back', () => {
    testDb = createTestDatabase()
    const id = randomUUID()

    const created = organizations.createOrganization(
      id,
      { name: 'Fall 2026 Chemistry', isPersonal: false },
      testDb.db
    )

    expect(created).toMatchObject({
      id,
      name: 'Fall 2026 Chemistry',
      isPersonal: false,
    })
    expect(typeof created.createdAt).toBe('number')

    const found = organizations.getOrganizationById(id, testDb.db)
    expect(found).toMatchObject({ id, name: 'Fall 2026 Chemistry' })
  })

  // TEN-1: an account gets a personal organization on sign-up.
  it('marks a personal organization with isPersonal', () => {
    testDb = createTestDatabase()
    const id = randomUUID()

    organizations.createOrganization(
      id,
      { name: 'jdoe@example.edu', isPersonal: true },
      testDb.db
    )

    expect(organizations.getOrganizationById(id, testDb.db)).toMatchObject({
      isPersonal: true,
    })
  })

  it('returns undefined for an organization that does not exist', () => {
    testDb = createTestDatabase()

    expect(
      organizations.getOrganizationById(randomUUID(), testDb.db)
    ).toBeUndefined()
  })

  // WEB-57: `renameOrganization` changes only `name`, and a later,
  // independent read sees it — not merely the value this one call echoes
  // back.
  it('renames an organization, and a later read returns the new name', () => {
    testDb = createTestDatabase()
    const id = randomUUID()
    organizations.createOrganization(
      id,
      { name: 'Old Name', isPersonal: false },
      testDb.db
    )

    const renamed = organizations.renameOrganization(id, 'New Name', testDb.db)
    expect(renamed).toMatchObject({ id, name: 'New Name' })

    expect(organizations.getOrganizationById(id, testDb.db)).toMatchObject({
      name: 'New Name',
    })
  })

  // `renameOrganization`'s own doc comment: `undefined` when the id does
  // not exist — the same "cannot tell you" refusal `getOrganizationById`
  // above already gives, and what `actions/organizations.ts`'s own
  // `if (!renamed) throw new ActionRefusedError()` guard depends on.
  it('returns undefined when renaming an organization that does not exist', () => {
    testDb = createTestDatabase()

    expect(
      organizations.renameOrganization(randomUUID(), 'New Name', testDb.db)
    ).toBeUndefined()
  })
})
