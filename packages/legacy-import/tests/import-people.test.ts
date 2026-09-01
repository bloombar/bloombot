/**
 * MIG-3 (first half): a legacy user becomes a person with a `discord`
 * identity and its roster fields.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { organizations, people } from '@bloombot/db'

import { importPeople } from '../src/import-people.js'
import type { LegacyUser } from '../src/read-legacy.js'
import {
  createTestPlatformDatabase,
  type TestPlatformDatabase,
} from './helpers/platform-db.js'

let testDb: TestPlatformDatabase

afterEach(() => {
  testDb.cleanup()
})

function legacyUser(overrides: Partial<LegacyUser> = {}): LegacyUser {
  return {
    id: 1,
    createdAt: '2026-01-15 10:00:00.000000',
    discordId: '100000000000000001',
    discordUsername: 'alice_smith',
    email: 'asmith@myuni.edu',
    firstName: 'Alice',
    lastName: 'Smith',
    githubUsername: 'alicesmith',
    ...overrides,
  }
}

describe('importPeople (MIG-3)', () => {
  it('creates a person with a discord identity and its roster fields', () => {
    testDb = createTestPlatformDatabase()
    const orgId = randomUUID()
    organizations.createOrganization(
      orgId,
      { name: 'Org', isPersonal: false },
      testDb.db
    )

    const outcomes = importPeople(orgId, [legacyUser()], testDb.db)

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      ok: true,
      created: true,
      legacyUserId: 1,
    })
    const outcome = outcomes[0]!
    const personId = outcome.ok ? outcome.personId : undefined
    expect(personId).toBeDefined()

    const resolved = people.resolveIdentity(
      orgId,
      { surface: 'discord', externalId: '100000000000000001' },
      testDb.db
    )
    expect(resolved?.id).toBe(personId)
    expect(resolved?.email).toBe('asmith@myuni.edu')
    expect(resolved?.firstName).toBe('Alice')
    expect(resolved?.lastName).toBe('Smith')
    expect(resolved?.githubHandle).toBe('alicesmith')
  })

  it('reports, rather than dropping, a legacy user with no discord_id', () => {
    testDb = createTestPlatformDatabase()
    const orgId = randomUUID()
    organizations.createOrganization(
      orgId,
      { name: 'Org', isPersonal: false },
      testDb.db
    )

    const outcomes = importPeople(
      orgId,
      [legacyUser({ id: 2, discordId: null })],
      testDb.db
    )

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.ok).toBe(false)
    expect(people.listPeople(orgId, testDb.db)).toHaveLength(0)
  })
})
