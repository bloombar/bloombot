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

  // --- Finding 1 of the MDL-1 rework: getPersonIdentity -------------------

  it('getPersonIdentity returns the identity for a person on a given surface', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const person = people.resolvePersonByIdentity(
      orgA,
      { surface: 'discord', externalId: 'snowflake-42' },
      testDb.db
    )

    expect(
      people.getPersonIdentity(orgA, person.id, 'discord', testDb.db)
    ).toMatchObject({ personId: person.id, externalId: 'snowflake-42' })
  })

  it('getPersonIdentity returns undefined for a surface the person has no identity on', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const person = people.resolvePersonByIdentity(
      orgA,
      { surface: 'discord', externalId: 'snowflake-43' },
      testDb.db
    )

    expect(
      people.getPersonIdentity(orgA, person.id, 'web', testDb.db)
    ).toBeUndefined()
  })

  it('getPersonIdentity refuses a person id belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    const person = people.resolvePersonByIdentity(
      orgA,
      { surface: 'discord', externalId: 'snowflake-44' },
      testDb.db
    )

    expect(
      people.getPersonIdentity(orgB, person.id, 'discord', testDb.db)
    ).toBeUndefined()
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

  // --- Finding 9 / D-13: the overwrite escape hatch -----------------------

  // `mergeRosterFields` only ever fills a gap, so a field set once from a
  // bad roster row (a mistyped email, say) is permanently wrong through
  // that function alone — a corrected re-import via `mergeRosterFields` is
  // a no-op, since the field is no longer `null`. `overwriteRosterFields`
  // is the other half: it replaces a field regardless of what is already
  // there.
  it('overwriteRosterFields replaces a field the person already has', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const person = people.createPerson(
      orgA,
      { email: 'typo@example.edu' },
      testDb.db
    )
    // A re-import through `mergeRosterFields` alone would be a no-op here.
    const unchanged = people.mergeRosterFields(
      orgA,
      person.id,
      { email: 'corrected@example.edu' },
      testDb.db
    )
    expect(unchanged?.email).toBe('typo@example.edu')

    const overwritten = people.overwriteRosterFields(
      orgA,
      person.id,
      { email: 'corrected@example.edu' },
      testDb.db
    )

    expect(overwritten?.email).toBe('corrected@example.edu')
    expect(people.getPerson(orgA, person.id, testDb.db)?.email).toBe(
      'corrected@example.edu'
    )
  })

  it('overwriteRosterFields leaves a field untouched when omitted', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const person = people.createPerson(
      orgA,
      { email: 'student@example.edu', firstName: 'Ada' },
      testDb.db
    )

    const overwritten = people.overwriteRosterFields(
      orgA,
      person.id,
      { firstName: 'Augusta' }, // `email` not named — left as-is
      testDb.db
    )

    expect(overwritten).toMatchObject({
      email: 'student@example.edu',
      firstName: 'Augusta',
    })
  })

  it('overwriteRosterFields refuses a person id belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    const personA = people.createPerson(
      orgA,
      { email: 'student@example.edu' },
      testDb.db
    )

    const result = people.overwriteRosterFields(
      orgB, // wrong organization
      personA.id,
      { email: 'someone-elses@example.edu' },
      testDb.db
    )

    expect(result).toBeUndefined()
    // Untouched.
    expect(people.getPerson(orgA, personA.id, testDb.db)?.email).toBe(
      'student@example.edu'
    )
  })

  // --- Finding 7: resolveIdentity constrains people.organizationId too ---

  // Not reachable through this package's own API today — `resolvePersonByIdentity`
  // always writes a person and its identity with the same `organizationId`,
  // so the two can never disagree yet. This constructs the disagreement
  // directly, with raw inserts, to prove `resolveIdentity` would refuse it
  // rather than leak another organization's person and roster fields.
  it('resolveIdentity refuses a person/identity pair whose organizations disagree', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizations(testDb)

    // A person that belongs to orgB...
    const personB = people.createPerson(orgB, {}, testDb.db)
    // ...reached through an identity that, if this ever happened, claims to
    // belong to orgA instead.
    testDb.db
      .insert(schema.personIdentities)
      .values({
        id: randomUUID(),
        organizationId: orgA,
        personId: personB.id,
        surface: 'discord',
        externalId: 'mismatched-snowflake',
        createdAt: Date.now(),
      })
      .run()

    expect(
      people.resolveIdentity(
        orgA,
        { surface: 'discord', externalId: 'mismatched-snowflake' },
        testDb.db
      )
    ).toBeUndefined()
  })

  // --- LINK-10: which organizations an account has a connected person in ---

  describe('listConnectedOrganizationsForAccount (LINK-10)', () => {
    it('reports an organization only once the account`s web identity there is actually connected', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      const accountId = randomUUID()

      // PPL-3's own "created on first sight, unconnected" case — a person
      // exists for this identity, but nothing has proven it yet.
      const unconnected = people.resolvePersonByIdentity(
        orgA,
        { surface: 'web', externalId: accountId },
        testDb.db
      )
      expect(unconnected.connectedAt).toBeNull()
      expect(
        people.listConnectedOrganizationsForAccount(accountId, testDb.db)
      ).toEqual([])

      // The real proof step (LINK-3) — `connectIdentity`, not a raw column
      // write — is what should make this organization reportable.
      const connected = people.connectIdentity(
        orgA,
        unconnected.id,
        { surface: 'web', externalId: accountId },
        testDb.db
      )
      expect(connected).toBeDefined()

      expect(
        people.listConnectedOrganizationsForAccount(accountId, testDb.db)
      ).toEqual([{ organizationId: orgA, personId: unconnected.id }])
    })

    it('says nothing about an organization the account has no person in at all', () => {
      testDb = createTestDatabase()
      seedTwoOrganizations(testDb)

      expect(
        people.listConnectedOrganizationsForAccount(randomUUID(), testDb.db)
      ).toEqual([])
    })

    // The exact shape LINK-10's own brief warns against seeding around: a
    // real student's own path is never "a web identity created directly in
    // the institution's organization" — it is a `discord`-surface person a
    // roster import admitted, whose identity later *merges* into the
    // account's own survivor once the account proves it owns that Discord
    // identity too (`@bloombot/auth#completeDiscordPersonLink`'s own
    // `connectOrMerge`). `mergePeople` moves every identity to the survivor
    // outright (that function's own comment) — this proves this read
    // follows the merge rather than staying pinned to whichever person the
    // account's `web` identity happened to be created against first.
    it('follows a merge: an organization becomes reachable through the survivor a discord identity was merged into, not only a person created there directly', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      const accountId = randomUUID()

      // The roster-admitted, discord-surface person — this student's real
      // starting point, unconnected to any account yet.
      const rosterPerson = people.resolvePersonByIdentity(
        orgA,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )

      // The account's own bare survivor in this organization (the same
      // shape `resolveOrCreateBareDiscordSurvivor`, `apps/api/src/routes/person-link.ts`,
      // creates before Discord's OAuth round trip even starts — D-44).
      const survivor = people.createPerson(orgA, {}, testDb.db)

      // The real merge — the roster-admitted identity moves onto the
      // survivor (LINK-4).
      const merge = people.mergePeople(
        orgA,
        survivor.id,
        rosterPerson.id,
        testDb.db
      )
      expect(merge?.alreadyMerged).toBe(false)

      // Then the account's own web identity attaches to the same survivor
      // (`attachWebIdentityOrMerge`'s own second step).
      const connected = people.connectIdentity(
        orgA,
        survivor.id,
        { surface: 'web', externalId: accountId },
        testDb.db
      )
      expect(connected).toBeDefined()

      expect(
        people.listConnectedOrganizationsForAccount(accountId, testDb.db)
      ).toEqual([{ organizationId: orgA, personId: survivor.id }])
    })
  })
})
