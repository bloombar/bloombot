import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { organizations, people, schema } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, synthetic data only (QA-3). */
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

describe('people repo', () => {
  // --- Tenant scoping (TEN-2/TEN-5) ---------------------------------------

  it('a person reachable from two organizations is only readable through its own', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    const personA = people.createPerson(orgA, {}, testDb.db)

    expect(people.getPerson(orgA, personA.id, testDb.db)).toMatchObject({
      id: personA.id,
    })
    // Same person id, wrong organization: indistinguishable from absence (TEN-5).
    expect(people.getPerson(orgB, personA.id, testDb.db)).toBeUndefined()
  })

  it('listPeople only lists an organization`s own people', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    people.createPerson(orgA, { displayName: 'A' }, testDb.db)
    people.createPerson(orgB, { displayName: 'B' }, testDb.db)

    expect(people.listPeople(orgA, testDb.db)).toHaveLength(1)
    expect(people.listPeople(orgB, testDb.db)).toHaveLength(1)
  })

  it('mergeRosterFields refuses a person id belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    const personA = people.createPerson(orgA, {}, testDb.db)

    const result = people.mergeRosterFields(
      orgB, // wrong organization
      personA.id,
      { email: 'student@example.edu' },
      testDb.db
    )

    expect(result).toBeUndefined()
    // Untouched.
    expect(people.getPerson(orgA, personA.id, testDb.db)?.email).toBeNull()
  })

  // --- PPL-2: identity uniqueness is structural ---------------------------

  it('refuses a second identity for the same (surface, external id) in one organization', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const personOne = people.createPerson(orgA, {}, testDb.db)
    testDb.db
      .insert(schema.personIdentities)
      .values({
        id: randomUUID(),
        organizationId: orgA,
        personId: personOne.id,
        surface: 'discord',
        externalId: 'snowflake-1',
        createdAt: Date.now(),
      })
      .run()

    const personTwo = people.createPerson(orgA, {}, testDb.db)
    expect(() =>
      testDb.db
        .insert(schema.personIdentities)
        .values({
          id: randomUUID(),
          organizationId: orgA,
          personId: personTwo.id,
          surface: 'discord',
          externalId: 'snowflake-1', // already claimed above, in this organization
          createdAt: Date.now(),
        })
        .run()
    ).toThrow()
  })

  it('allows the same (surface, external id) in a different organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    const personA = people.resolvePersonByIdentity(
      orgA,
      { surface: 'discord', externalId: 'shared-snowflake' },
      testDb.db
    )
    const personB = people.resolvePersonByIdentity(
      orgB,
      { surface: 'discord', externalId: 'shared-snowflake' },
      testDb.db
    )

    expect(personA.id).not.toBe(personB.id)
    expect(people.listPeople(orgA, testDb.db)).toHaveLength(1)
    expect(people.listPeople(orgB, testDb.db)).toHaveLength(1)
  })

  // --- PPL-3: created on demand --------------------------------------------

  it('resolving an unknown identity creates the person and the identity together', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const person = people.resolvePersonByIdentity(
      orgA,
      { surface: 'discord', externalId: 'new-snowflake' },
      testDb.db
    )

    expect(people.listPeople(orgA, testDb.db)).toEqual([person])
    expect(
      people.resolveIdentity(
        orgA,
        { surface: 'discord', externalId: 'new-snowflake' },
        testDb.db
      )
    ).toMatchObject({ id: person.id })
  })

  it('resolving a known identity returns the existing person and creates nothing', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const first = people.resolvePersonByIdentity(
      orgA,
      { surface: 'discord', externalId: 'repeat-snowflake' },
      testDb.db
    )
    const second = people.resolvePersonByIdentity(
      orgA,
      { surface: 'discord', externalId: 'repeat-snowflake' },
      testDb.db
    )

    expect(second.id).toBe(first.id)
    // Exactly one person, one identity — the second call created nothing.
    expect(people.listPeople(orgA, testDb.db)).toHaveLength(1)
    expect(testDb.db.select().from(schema.personIdentities).all()).toHaveLength(
      1
    )
  })

  // A failure part-way through the create-together transaction must leave
  // neither the person nor the identity behind. `identity.surface` is typed
  // to `Surface` at compile time, so an invalid value can only be forced
  // past the type checker (`as never`) — exactly the way a corrupt caller,
  // or a future code path that forgets to validate, could still reach the
  // database. The identity insert's own `person_identities_surface_check`
  // (`schema.ts`) throws before it commits, so this proves the transaction
  // rolls back the person insert that came before it too, not just that the
  // identity insert itself failed.
  it('a failure part-way through resolving an unknown identity creates neither row', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    expect(() =>
      people.resolvePersonByIdentity(
        orgA,
        { surface: 'not-a-real-surface' as never, externalId: 'doomed' },
        testDb.db
      )
    ).toThrow()

    expect(people.listPeople(orgA, testDb.db)).toHaveLength(0)
    expect(testDb.db.select().from(schema.personIdentities).all()).toHaveLength(
      0
    )
  })

  // --- Merging roster fields -------------------------------------------

  it('merges roster fields onto a person with none set', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const person = people.createPerson(orgA, {}, testDb.db)
    const merged = people.mergeRosterFields(
      orgA,
      person.id,
      { email: 'student@example.edu', firstName: 'Ada', lastName: 'Lovelace' },
      testDb.db
    )

    expect(merged).toMatchObject({
      email: 'student@example.edu',
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
  })

  it('does not overwrite a field the person already has', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const person = people.createPerson(
      orgA,
      { displayName: 'adalovelace#0001' },
      testDb.db
    )
    const merged = people.mergeRosterFields(
      orgA,
      person.id,
      { displayName: 'Ada Lovelace' }, // the roster's guess, not authoritative over an existing value
      testDb.db
    )

    expect(merged?.displayName).toBe('adalovelace#0001')
  })
})
