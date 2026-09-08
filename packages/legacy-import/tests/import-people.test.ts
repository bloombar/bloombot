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

  // finding 4: a correction made since the last import (an instructor
  // filling in a blank email, say) must survive a re-run — the legacy
  // snapshot is the *oldest* source of roster data in the system, not the
  // newest, so it must only fill a field that is still `null`, never
  // overwrite one something else has since set (docs/DECISIONS.md D-14).
  it('does not clobber a roster field filled in since the last import', () => {
    testDb = createTestPlatformDatabase()
    const orgId = randomUUID()
    organizations.createOrganization(
      orgId,
      { name: 'Org', isPersonal: false },
      testDb.db
    )

    // First import: the legacy row has no email or name yet.
    const first = importPeople(
      orgId,
      [
        legacyUser({
          email: null,
          firstName: null,
          lastName: null,
          githubUsername: null,
        }),
      ],
      testDb.db
    )
    const personId = first[0]!.ok ? first[0]!.personId : undefined
    expect(personId).toBeDefined()

    // A correction lands between imports — an instructor fixing the roster
    // by hand, or a later roster import; either way, not this importer.
    people.overwriteRosterFields(
      orgId,
      personId!,
      { email: 'alice@myuni.edu', firstName: 'Alice', lastName: 'Smith' },
      testDb.db
    )

    // Re-running the same legacy snapshot must not reset any of that.
    const second = importPeople(orgId, [legacyUser()], testDb.db)
    expect(second[0]).toMatchObject({ ok: true, created: false, personId })

    const resolved = people.getPerson(orgId, personId!, testDb.db)
    expect(resolved?.email).toBe('alice@myuni.edu')
    expect(resolved?.firstName).toBe('Alice')
    expect(resolved?.lastName).toBe('Smith')
    // `githubHandle` was never corrected, so the legacy value still merges in.
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
