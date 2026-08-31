import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { accounts, discordServers, organizations, schema } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one account to install the bot. */
function seedTwoOrganizationsWithInstallers(testDatabase: TestDatabase) {
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
  const installerA = accounts.createAccount(
    orgA,
    { email: 'a@example.edu', displayName: 'A', role: 'owner' },
    testDatabase.db
  )
  const installerB = accounts.createAccount(
    orgB,
    { email: 'b@example.edu', displayName: 'B', role: 'owner' },
    testDatabase.db
  )
  return { orgA, orgB, installerA, installerB }
}

describe('discord-servers repo', () => {
  it('claims a never-bound snowflake for an organization', () => {
    testDb = createTestDatabase()
    const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '111111111111111111'

    const binding = discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )

    expect(binding).toMatchObject({ serverId, organizationId: orgA })
    expect(binding?.removedAt).toBeNull()
  })

  it('resolves a bound snowflake to its organization, unscoped (TEN-2 exception #2)', () => {
    testDb = createTestDatabase()
    const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '222222222222222222'

    discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )

    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId: orgA })
  })

  it('resolves an unbound snowflake to undefined', () => {
    testDb = createTestDatabase()

    expect(
      discordServers.resolveDiscordServerBinding('no-such-server', testDb.db)
    ).toBeUndefined()
  })

  // TEN-3: one organization per Discord server, enforced at the database
  // level — a raw second insert for an already-bound snowflake fails, even
  // bypassing the repo's claim logic entirely.
  it('fails a second raw insert for an already-bound snowflake at the database level', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, installerA, installerB } =
      seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '333333333333333333'

    testDb.db
      .insert(schema.discordServerBindings)
      .values({
        serverId,
        organizationId: orgA,
        installedByAccountId: installerA.id,
        installedAt: Date.now(),
      })
      .run()

    expect(() =>
      testDb.db
        .insert(schema.discordServerBindings)
        .values({
          serverId,
          organizationId: orgB,
          installedByAccountId: installerB.id,
          installedAt: Date.now(),
        })
        .run()
    ).toThrow()
  })

  // TEN-3: the repo's claim function refuses a server actively bound to a
  // different organization rather than throwing something that could be
  // mistaken for "does not exist".
  it('refuses to claim a snowflake actively bound to a different organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, installerA, installerB } =
      seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '444444444444444444'

    discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )

    const blocked = discordServers.claimDiscordServerBinding(
      orgB,
      { serverId, installedByAccountId: installerB.id },
      testDb.db
    )

    expect(blocked).toBeUndefined()
    // Still bound to the original organization, untouched.
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId: orgA })
  })

  it('claiming a snowflake already actively bound to the same organization is idempotent', () => {
    testDb = createTestDatabase()
    const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '999999999999999999'

    const first = discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )
    const second = discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )

    expect(second).toMatchObject({ serverId, organizationId: orgA })
    expect(second?.installedAt).toBe(first?.installedAt)
  })

  // TEN-6: removal marks the binding inactive rather than deleting it, and
  // TEN-3 explicitly allows a released snowflake to be re-claimed — by any
  // organization, not only the one that originally held it.
  it('lets a removed binding be re-claimed', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, installerA, installerB } =
      seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '555555555555555555'

    discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )
    discordServers.removeDiscordServerBinding(orgA, serverId, testDb.db)

    // Removed: no longer resolves to anyone.
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toBeUndefined()

    const reclaimed = discordServers.claimDiscordServerBinding(
      orgB,
      { serverId, installedByAccountId: installerB.id },
      testDb.db
    )

    expect(reclaimed).toMatchObject({ serverId, organizationId: orgB })
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId: orgB })
  })

  // TEN-2: removing through the wrong organization affects zero rows rather
  // than the other tenant's binding.
  it('removing through the wrong organization affects zero rows', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, installerA } =
      seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '666666666666666666'

    discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )

    const changed = discordServers.removeDiscordServerBinding(
      orgB,
      serverId,
      testDb.db
    )

    expect(changed).toBe(0)
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId: orgA })
  })

  it('lists only the bindings belonging to the given organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, installerA, installerB } =
      seedTwoOrganizationsWithInstallers(testDb)

    discordServers.claimDiscordServerBinding(
      orgA,
      { serverId: '777777777777777777', installedByAccountId: installerA.id },
      testDb.db
    )
    discordServers.claimDiscordServerBinding(
      orgB,
      { serverId: '888888888888888888', installedByAccountId: installerB.id },
      testDb.db
    )

    const rows = discordServers.listDiscordServerBindingsForOrganization(
      orgA,
      testDb.db
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ serverId: '777777777777777777' })
  })
})
