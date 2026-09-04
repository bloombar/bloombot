import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  accounts,
  closeDatabase,
  courses,
  discordServers,
  openDatabase,
  organizations,
  projects,
  schema,
  type Database,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * Stubs a connection's *second* `db.select(...)` call to return `staleResult`
 * instead of querying the table — every other call (including the first,
 * `claimDiscordServerBinding`'s membership check) still hits the real
 * database. This is how the TEN-3 race tests below put a connection into the
 * exact window a genuinely concurrent process can land in — its own read
 * happened before another connection's write committed — which a
 * single-threaded test cannot reach naturally, because better-sqlite3's
 * calls are synchronous and independent (no transaction holds a snapshot
 * across them), so nothing else can run between one connection's own read
 * and its own write. Only the read is faked; the write that follows runs for
 * real, against the real database, through the real exported function — so
 * it is that write's own guard (the fix under test) that decides the
 * outcome.
 */
function stubSecondReadAsStale(
  db: Database,
  staleResult: discordServers.DiscordServerBinding | undefined
): void {
  const realSelect = db.select.bind(db)
  vi.spyOn(db, 'select')
    .mockImplementationOnce(realSelect as never)
    .mockImplementationOnce(
      () =>
        ({
          from: () => ({ where: () => ({ get: () => staleResult }) }),
        }) as never
    )
}

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

  // TEN-4 (data-layer half): the foreign key on `installed_by_account_id`
  // only proves the account exists *somewhere* — it says nothing about
  // whether that account belongs to the organization doing the claiming. A
  // foreign tenant's account must not be recordable as the installer.
  it('refuses to claim when the installing account is not a member of the claiming organization', () => {
    testDb = createTestDatabase()
    const { orgA, installerB } = seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '110110110110110110'

    const blocked = discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerB.id }, // a member of Org B, not Org A
      testDb.db
    )

    expect(blocked).toBeUndefined()
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toBeUndefined()
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

  // TEN-3: the insert branch must report "already claimed elsewhere" the
  // same way the other two branches do — `undefined`, not SQLite's raw
  // constraint error escaping for a caller to pattern-match on.
  it('returns undefined, not a thrown error, when a concurrent connection already claimed a never-bound snowflake', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, installerA, installerB } =
      seedTwoOrganizationsWithInstallers(testDb)
    const serverId = '101101101101101101'

    // Connection 1 claims the never-bound snowflake for real — wins.
    const winner = discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )
    expect(winner).toMatchObject({ organizationId: orgA })

    // Connection 2's own lookup is stubbed stale — as it would have seen
    // this snowflake had it looked before connection 1's insert committed —
    // so it still believes the snowflake is free and attempts the real
    // INSERT below, which hits the real primary key SQLite already enforces.
    const db2 = openDatabase(testDb.path)
    stubSecondReadAsStale(db2, undefined)

    const loser = discordServers.claimDiscordServerBinding(
      orgB,
      { serverId, installedByAccountId: installerB.id },
      db2
    )

    expect(loser).toBeUndefined()
    closeDatabase(db2)
    // Untouched: still connection 1's claim.
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId: orgA })
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

  // TEN-3: the re-claim UPDATE must be a single conditional statement — a
  // concurrent connection whose own read is stale must not be able to
  // silently overwrite the winner's claim.
  it('refuses a re-claim whose own read is stale — the write loses the race', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, installerA, installerB } =
      seedTwoOrganizationsWithInstallers(testDb)
    const orgC = randomUUID()
    organizations.createOrganization(
      orgC,
      { name: 'Org C', isPersonal: false },
      testDb.db
    )
    const installerC = accounts.createAccount(
      orgC,
      { email: 'c@example.edu', displayName: 'C', role: 'owner' },
      testDb.db
    )
    const serverId = '202202202202202202'

    discordServers.claimDiscordServerBinding(
      orgA,
      { serverId, installedByAccountId: installerA.id },
      testDb.db
    )
    discordServers.removeDiscordServerBinding(orgA, serverId, testDb.db)

    // The released binding, as connection 2 would have seen it had it
    // looked before connection 1's re-claim below committed.
    const staleRelease = testDb.db
      .select()
      .from(schema.discordServerBindings)
      .where(eq(schema.discordServerBindings.serverId, serverId))
      .get()

    // Connection 1 re-claims for Org B, through the repo function — wins.
    const winner = discordServers.claimDiscordServerBinding(
      orgB,
      { serverId, installedByAccountId: installerB.id },
      testDb.db
    )
    expect(winner).toMatchObject({ organizationId: orgB })

    // Connection 2's own lookup is stubbed to return that stale, released
    // snapshot, so it still believes the snowflake is free to re-claim and
    // attempts the real UPDATE below, for Org C.
    const db2 = openDatabase(testDb.path)
    stubSecondReadAsStale(db2, staleRelease)

    const loser = discordServers.claimDiscordServerBinding(
      orgC,
      { serverId, installedByAccountId: installerC.id },
      db2
    )

    expect(loser).toBeUndefined()
    closeDatabase(db2)
    // Untouched: still connection 1's claim.
    expect(
      discordServers.resolveDiscordServerBinding(serverId, testDb.db)
    ).toMatchObject({ organizationId: orgB })
  })

  // TEN-9 (must-fix 1, coordinator round 1 rework) — claiming a *second*
  // active binding backfills every null-`discordServerId` course onto the
  // organization's previous sole binding, at the exact moment that column
  // stops being unambiguous. See `docs/DECISIONS.md` D-76 for why: without
  // this, installing an unrelated second server silently stopped every
  // pre-existing course routing at all (`packages/discord/tests/handle-mention.test.ts`'s
  // own "installing a second server does not stop..." case is the full,
  // routing-level pin of this same fix).
  describe('claiming a second active binding backfills null-server courses (TEN-9)', () => {
    function seedNullServerCourse(
      testDatabase: TestDatabase,
      organizationId: string,
      options: { enabled?: boolean } = {}
    ) {
      const project = projects.createProject(
        organizationId,
        { name: `Term ${randomUUID()}` },
        testDatabase.db
      )
      const result = courses.createCourse(
        organizationId,
        {
          projectId: project.id,
          title: 'Existing Course',
          filePrefix: `ec-${randomUUID().slice(0, 8)}`,
          enabled: options.enabled ?? true,
          adminsRole: `admins-${randomUUID()}`,
          studentsRole: `students-${randomUUID()}`,
          categories: [],
        },
        testDatabase.db
      )
      if (!result.ok) {
        throw new Error(`setup failed: ${result.conflict.message}`)
      }
      return result.course
    }

    it("backfills a pre-existing null-server course onto the organization's previous sole binding once a second is claimed", () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const firstServerId = '777777777777777701'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: firstServerId, installedByAccountId: installerA.id },
        testDb.db
      )
      const course = seedNullServerCourse(testDb, orgA)
      expect(course.discordServerId).toBeNull()

      const secondServerId = '777777777777777702'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: secondServerId, installedByAccountId: installerA.id },
        testDb.db
      )

      const reloaded = courses.getCourse(orgA, course.id, testDb.db)
      expect(reloaded?.discordServerId).toBe(firstServerId)
    })

    it('does not touch a course that already names a server explicitly', () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const firstServerId = '777777777777777703'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: firstServerId, installedByAccountId: installerA.id },
        testDb.db
      )
      const course = seedNullServerCourse(testDb, orgA)
      const explicitlySet = courses.updateCourse(
        orgA,
        course.id,
        {
          projectId: course.projectId,
          title: course.title,
          filePrefix: course.filePrefix,
          enabled: course.enabled,
          adminsRole: course.adminsRole,
          studentsRole: course.studentsRole,
          discordServerId: firstServerId,
          categories: [],
        },
        testDb.db
      )
      if (!explicitlySet?.ok)
        throw new Error('setup failed: unexpected conflict')

      const secondServerId = '777777777777777704'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: secondServerId, installedByAccountId: installerA.id },
        testDb.db
      )

      const reloaded = courses.getCourse(orgA, course.id, testDb.db)
      expect(reloaded?.discordServerId).toBe(firstServerId)
    })

    it('does not backfill a third binding — only the exact 1-to-2 transition', () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const firstServerId = '777777777777777705'
      const secondServerId = '777777777777777706'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: firstServerId, installedByAccountId: installerA.id },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: secondServerId, installedByAccountId: installerA.id },
        testDb.db
      )
      // A course created *after* the organization is already ambiguous never
      // had a single "previous" server to attribute it to. It cannot even
      // be created enabled with a null column at that point
      // (`repos/courses.ts`'s own enablement guard) — created disabled here,
      // the state a genuinely undecided course is left in, not guessed at
      // by this backfill.
      const course = seedNullServerCourse(testDb, orgA, { enabled: false })

      const thirdServerId = '777777777777777707'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: thirdServerId, installedByAccountId: installerA.id },
        testDb.db
      )

      const reloaded = courses.getCourse(orgA, course.id, testDb.db)
      expect(reloaded?.discordServerId).toBeNull()
    })

    it("does not backfill another organization's course", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, installerA, installerB } =
        seedTwoOrganizationsWithInstallers(testDb)
      const firstServerId = '777777777777777708'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: firstServerId, installedByAccountId: installerA.id },
        testDb.db
      )
      const courseInOrgA = seedNullServerCourse(testDb, orgA)

      // Org B's own second binding must not touch Org A's course.
      const orgBFirstServerId = '777777777777777709'
      discordServers.claimDiscordServerBinding(
        orgB,
        { serverId: orgBFirstServerId, installedByAccountId: installerB.id },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgB,
        {
          serverId: '777777777777777710',
          installedByAccountId: installerB.id,
        },
        testDb.db
      )

      const reloaded = courses.getCourse(orgA, courseInOrgA.id, testDb.db)
      expect(reloaded?.discordServerId).toBeNull()
    })
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

  // Backs `@bloombot/actions`' `discordServers.remove` policy — unlike
  // `resolveDiscordServerBinding` above, this one is reached with an
  // organization already known.
  describe('getActiveDiscordServerBinding', () => {
    it("resolves an active binding when it belongs to the caller's organization", () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '121212121212121212'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installerA.id },
        testDb.db
      )

      expect(
        discordServers.getActiveDiscordServerBinding(orgA, serverId, testDb.db)
      ).toMatchObject({ serverId, organizationId: orgA })
    })

    // TEN-5: a binding belonging to a different organization resolves to
    // `undefined`, the same as one that never existed.
    it("resolves to undefined for another organization's binding", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, installerA } =
        seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '131313131313131313'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installerA.id },
        testDb.db
      )

      expect(
        discordServers.getActiveDiscordServerBinding(orgB, serverId, testDb.db)
      ).toBeUndefined()
    })

    it('resolves to undefined for a removed binding, even for the organization that held it', () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '141414141414141414'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installerA.id },
        testDb.db
      )
      discordServers.removeDiscordServerBinding(orgA, serverId, testDb.db)

      expect(
        discordServers.getActiveDiscordServerBinding(orgA, serverId, testDb.db)
      ).toBeUndefined()
    })

    it('resolves to undefined for a snowflake that was never bound', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizationsWithInstallers(testDb)

      expect(
        discordServers.getActiveDiscordServerBinding(
          orgA,
          'no-such-server',
          testDb.db
        )
      ).toBeUndefined()
    })
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

  // SRV-6 — what `apps/worker/src/handlers/discord-scaffold.ts` resolves a
  // job's `courseId`-only payload to a guild through.
  describe('getActiveDiscordServerBindingForOrganization', () => {
    it("resolves the organization's one active binding", () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '151515151515151515'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installerA.id },
        testDb.db
      )

      expect(
        discordServers.getActiveDiscordServerBindingForOrganization(
          orgA,
          testDb.db
        )
      ).toMatchObject({ serverId, organizationId: orgA })
    })

    it('resolves to undefined for an organization with no active binding at all', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizationsWithInstallers(testDb)

      expect(
        discordServers.getActiveDiscordServerBindingForOrganization(
          orgA,
          testDb.db
        )
      ).toBeUndefined()
    })

    it("resolves to undefined once the organization's only binding is removed, rather than resurrecting it", () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '161616161616161616'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installerA.id },
        testDb.db
      )
      discordServers.removeDiscordServerBinding(orgA, serverId, testDb.db)

      expect(
        discordServers.getActiveDiscordServerBindingForOrganization(
          orgA,
          testDb.db
        )
      ).toBeUndefined()
    })

    // TEN-5/TEN-2: never resolves another organization's binding.
    it("does not resolve another organization's active binding", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, installerB } =
        seedTwoOrganizationsWithInstallers(testDb)
      discordServers.claimDiscordServerBinding(
        orgB,
        {
          serverId: '171717171717171717',
          installedByAccountId: installerB.id,
        },
        testDb.db
      )

      expect(
        discordServers.getActiveDiscordServerBindingForOrganization(
          orgA,
          testDb.db
        )
      ).toBeUndefined()
    })

    // Documented edge case (this file's own module comment): more than one
    // active binding has no single guild to resolve to, so this refuses
    // exactly like "none bound" rather than guessing.
    it('resolves to undefined when the organization holds more than one active binding', () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '181818181818181818',
          installedByAccountId: installerA.id,
        },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '191919191919191919',
          installedByAccountId: installerA.id,
        },
        testDb.db
      )

      expect(
        discordServers.getActiveDiscordServerBindingForOrganization(
          orgA,
          testDb.db
        )
      ).toBeUndefined()
    })
  })

  // TEN-9 — replaces `getActiveDiscordServerBindingForOrganization` for every
  // caller resolving *a course's* server rather than "the organization's
  // one binding".
  describe('resolveCourseDiscordServer', () => {
    it("resolves a null column through the organization's single active binding", () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '202020202020202020'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installerA.id },
        testDb.db
      )

      const result = discordServers.resolveCourseDiscordServer(
        orgA,
        null,
        testDb.db
      )

      expect(result).toMatchObject({ ok: true, binding: { serverId } })
    })

    it('resolves a null column to a resolved "no server" — not a refusal — when the organization has no active binding at all', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizationsWithInstallers(testDb)

      expect(
        discordServers.resolveCourseDiscordServer(orgA, null, testDb.db)
      ).toEqual({ ok: true, binding: undefined })
    })

    it('refuses a null column as ambiguous when the organization holds two or more active bindings', () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '212121212121212121',
          installedByAccountId: installerA.id,
        },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '222222222222222222',
          installedByAccountId: installerA.id,
        },
        testDb.db
      )

      expect(
        discordServers.resolveCourseDiscordServer(orgA, null, testDb.db)
      ).toEqual({ ok: false, reason: 'ambiguous' })
    })

    it("resolves a course's own server even when the organization holds two active bindings", () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const serverA = '232323232323232323'
      const serverB = '242424242424242424'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: serverA, installedByAccountId: installerA.id },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: serverB, installedByAccountId: installerA.id },
        testDb.db
      )

      expect(
        discordServers.resolveCourseDiscordServer(orgA, serverB, testDb.db)
      ).toMatchObject({ ok: true, binding: { serverId: serverB } })
    })

    it('refuses a column naming a binding that has since been removed', () => {
      testDb = createTestDatabase()
      const { orgA, installerA } = seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '252525252525252525'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installerA.id },
        testDb.db
      )
      discordServers.removeDiscordServerBinding(orgA, serverId, testDb.db)

      expect(
        discordServers.resolveCourseDiscordServer(orgA, serverId, testDb.db)
      ).toEqual({ ok: false, reason: 'removed' })
    })

    // TEN-5/TEN-2: a column naming another organization's (even active)
    // binding is refused exactly the same way as a removed one — not
    // resolved across the tenant boundary.
    it("refuses a column naming another organization's binding", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, installerB } =
        seedTwoOrganizationsWithInstallers(testDb)
      const serverId = '262626262626262626'
      discordServers.claimDiscordServerBinding(
        orgB,
        { serverId, installedByAccountId: installerB.id },
        testDb.db
      )

      expect(
        discordServers.resolveCourseDiscordServer(orgA, serverId, testDb.db)
      ).toEqual({ ok: false, reason: 'removed' })
    })
  })
})
