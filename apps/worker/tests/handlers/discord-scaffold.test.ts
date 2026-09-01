/**
 * `discordServers.scaffold` (SRV-6..8) — the first real handler through the
 * queue, asserted against a real, throwaway database and a loopback fake
 * standing in for Discord's guild-management endpoints
 * (`FakeDiscordGuildServer`). Each test below fails without this slice's
 * code: before it, `apps/worker` registered no handler at all, and neither
 * `createDiscordScaffoldHandler` nor `getActiveDiscordServerBindingForOrganization`
 * existed.
 */

import { randomUUID } from 'node:crypto'

import { courses, jobs, organizations, projects } from '@bloombot/db'
import {
  createDiscordRestClient,
  type DiscordRestClient,
} from '@bloombot/discord-rest'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createDiscordScaffoldHandler,
  DISCORD_SCAFFOLD_JOB_KIND,
} from '../../src/handlers/discord-scaffold.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { FakeDiscordGuildServer } from '../helpers/fake-discord-guild-server.js'
import { seedOrganizationWithBoundCourse } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase
let discordServer: FakeDiscordGuildServer

afterEach(async () => {
  testDb.cleanup()
  await discordServer.stop()
})

const retryPolicy: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

/** Runs the scaffold handler directly (no queue) against `discordServer`, the same fake every test in this file points at. */
async function runScaffold(
  organizationId: string,
  courseId: string
): Promise<unknown> {
  const handler = createDiscordScaffoldHandler({
    discordRestClient: createDiscordRestClient({
      clientId: 'unused',
      clientSecret: 'unused',
      apiBase: discordServer.baseUrl,
      // Also pointed at the fake, never CONFIG's real default — `createDiscordRestClient`
      // reads `CONFIG.DISCORD_OAUTH_BASE` the moment `oauthBase` is omitted (`client.ts`),
      // and this test's environment sets none of the variables that would need.
      oauthBase: discordServer.baseUrl,
    }),
    botToken: 'bot-token',
  })
  return handler(
    { courseId },
    {
      organizationId,
      jobId: randomUUID(),
      attempts: 1,
      db: testDb.db,
      logger: createFakeLogger(),
    }
  )
}

describe('discordServers.scaffold handler', () => {
  // SRV-6: a course with a named-channels category and a bare category
  // produces exactly those categories and channels in the fake, with the
  // right permission overwrites.
  it('creates a declared category with named channels, and a bare category with its temp placeholder, with the right permission overwrites', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      {
        name: 'Week 1',
        channels: [
          { name: 'general', adminsOnly: false },
          { name: 'admins', adminsOnly: true },
        ],
      },
      { name: 'Week 2', channels: [] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: {
        name: string
        status: string
        channels: { name: string; status: string }[]
      }[]
      undeclaredCategories: string[]
      unresolvedRoles: string[]
    }

    expect(report.unresolvedRoles).toEqual([])
    expect(report.undeclaredCategories).toEqual([])
    expect(report.categories).toEqual([
      {
        name: 'Week 1',
        status: 'created',
        everyoneDenied: true,
        establishedByThisRun: true,
        channels: [
          {
            name: 'general',
            status: 'created',
            adminsOnly: false,
            establishedByThisRun: true,
          },
          {
            name: 'admins',
            status: 'created',
            adminsOnly: true,
            establishedByThisRun: true,
          },
        ],
      },
      {
        name: 'Week 2',
        status: 'created',
        everyoneDenied: true,
        establishedByThisRun: true,
        channels: [
          {
            name: 'temp',
            status: 'created',
            adminsOnly: false,
            establishedByThisRun: true,
          },
        ],
      },
    ])

    // Exactly those categories and channels landed in the fake.
    const guildChannels = discordServer.writeRequests().map((r) => r.body)
    expect(guildChannels).toHaveLength(5) // 2 categories + general + admins + temp

    const week1 = guildChannels.find((c) => c?.['name'] === 'Week 1') as Record<
      string,
      unknown
    >
    expect(week1['type']).toBe(4)
    const overwrites = week1['permission_overwrites'] as {
      id: string
      allow: string
      deny: string
    }[]
    expect(overwrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: seeded.guildId, deny: '1024' }),
        expect.objectContaining({ id: 'role-admins', allow: '3072' }),
        expect.objectContaining({ id: 'role-students', allow: '3072' }),
      ])
    )

    const adminsChannel = guildChannels.find(
      (c) => c?.['name'] === 'admins'
    ) as Record<string, unknown>
    expect(adminsChannel['permission_overwrites']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: seeded.guildId, deny: '1024' }),
        expect.objectContaining({ id: 'role-admins', allow: '3072' }),
      ])
    )
    // Admins-only overwrite must not grant the students role.
    expect(adminsChannel['permission_overwrites']).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'role-students' })])
    )

    const generalChannel = guildChannels.find(
      (c) => c?.['name'] === 'general'
    ) as Record<string, unknown>
    // Inherits from its category — no explicit overwrite sent at all.
    expect(generalChannel).not.toHaveProperty('permission_overwrites')
  })

  // SRV-7: running the handler twice creates nothing the second time, and
  // the second report says "already present" rather than "created" —
  // asserted against the fake's own recorded calls, not just the report.
  it('creates nothing on a second run, reporting already_present instead of created', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    await runScaffold(seeded.organizationId, seeded.courseId)
    const createCallsAfterFirstRun = discordServer.writeRequests().length
    expect(createCallsAfterFirstRun).toBe(2) // category + channel

    const secondReport = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: {
        name: string
        status: string
        channels: { name: string; status: string }[]
      }[]
    }

    // No new create calls at all on the fake.
    expect(discordServer.writeRequests()).toHaveLength(createCallsAfterFirstRun)
    expect(secondReport.categories).toEqual([
      {
        name: 'Week 1',
        status: 'already_present',
        everyoneDenied: true,
        establishedByThisRun: false,
        channels: [
          {
            name: 'general',
            status: 'already_present',
            adminsOnly: false,
            establishedByThisRun: false,
          },
        ],
      },
    ])
  })

  // Finding 1 of the SRV-6..8 rework: Discord slugs a `GUILD_TEXT`
  // channel's own name at creation (spaces become dashes) — `general chat`
  // comes back from the guild as `general-chat`, never `general chat`. A
  // match that compares the declared name against the guild's own, without
  // applying that same transform, never finds it — the whole of SRV-7
  // broken on the first channel name with a space in it.
  it('matches a channel Discord slugged on creation, so a name with a space in it stays idempotent', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      {
        name: 'Week 1',
        channels: [{ name: 'general chat', adminsOnly: false }],
      },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    await runScaffold(seeded.organizationId, seeded.courseId)
    expect(discordServer.writeRequests()).toHaveLength(2) // category + channel

    // The fake's own guild store proves Discord's own slugging actually
    // happened, not just that the handler's report looked right.
    const stored = discordServer.guildChannelsFor(seeded.guildId) as Record<
      string,
      unknown
    >[]
    const storedChannel = stored.find((c) => c['type'] === 0)
    expect(storedChannel?.['name']).toBe('general-chat')

    const secondReport = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: { channels: { name: string; status: string }[] }[]
    }

    // Nothing new was created the second time — a duplicate here would be
    // exactly the bug this test exists to catch.
    expect(discordServer.writeRequests()).toHaveLength(2)
    expect(secondReport.categories[0]?.channels).toEqual([
      expect.objectContaining({
        name: 'general chat',
        status: 'already_present',
      }),
    ])
  })

  // Finding 6 of the SRV-6..8 rework: the case- and whitespace-insensitive
  // matching this handler's own module comment (and three others) claims
  // for both categories and channels had no test of its own before this —
  // an existing category/channel differing only in case or leading/trailing
  // whitespace must still be recognised as the same one.
  it('matches an existing category and channel that differ only in case or surrounding whitespace', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'General', adminsOnly: false }] },
    ])
    discordServer.setGuildChannels(seeded.guildId, [
      { id: 'cat-1', type: 4, name: '  week 1  ', parent_id: null },
      { id: 'chan-1', type: 0, name: 'GENERAL', parent_id: 'cat-1' },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: {
        name: string
        status: string
        channels: { name: string; status: string }[]
      }[]
    }

    // Nothing was created at all — both the category and its channel were
    // recognised as already present despite the case/whitespace mismatch.
    expect(discordServer.writeRequests()).toHaveLength(0)
    expect(report.categories).toEqual([
      expect.objectContaining({
        name: 'Week 1',
        status: 'already_present',
        channels: [
          expect.objectContaining({
            name: 'General',
            status: 'already_present',
          }),
        ],
      }),
    ])
  })

  // Finding 6 of the SRV-6..8 rework: D-30's central safety argument — a
  // retry re-lists the guild from scratch and adopts whatever a failed
  // partial attempt already created, rather than recreating it — had no
  // test. A `DiscordRestClient` that fails once, partway through a course's
  // channels, proves it: the category and the first channel survive the
  // failed attempt, and the retry creates only what was never reached.
  it('a retry after a partial failure adopts what the failed attempt already created, rather than recreating it (D-30)', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      {
        name: 'Week 1',
        channels: [
          { name: 'general', adminsOnly: false },
          { name: 'announcements', adminsOnly: false },
        ],
      },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const realClient = createDiscordRestClient({
      clientId: 'unused',
      clientSecret: 'unused',
      apiBase: discordServer.baseUrl,
      oauthBase: discordServer.baseUrl,
    })

    // Fails exactly once — creating "announcements" on the first attempt
    // only — simulating a Discord transport error after the category and
    // the first channel already landed for real.
    let shouldFail = true
    const flakyClient: DiscordRestClient = {
      ...realClient,
      createGuildChannel(botToken, guildId, input) {
        if (input.name === 'announcements' && shouldFail) {
          shouldFail = false
          return Promise.reject(new Error('simulated transport failure'))
        }
        return realClient.createGuildChannel(botToken, guildId, input)
      },
    }

    jobs.enqueueJob(
      seeded.organizationId,
      {
        kind: DISCORD_SCAFFOLD_JOB_KIND,
        payload: { courseId: seeded.courseId },
        maxAttempts: 3,
      },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register(
      DISCORD_SCAFFOLD_JOB_KIND,
      createDiscordScaffoldHandler({
        discordRestClient: flakyClient,
        botToken: 'bot-token',
      })
    )
    const runDeps = {
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      // No real backoff wait — this test proves the retry's own matching
      // logic, not the schedule (`packages/jobs/tests/runner.test.ts` proves
      // that).
      retryPolicy: { baseDelayMs: 0, backoffFactor: 1 },
    }

    const firstAttempt = await runNextJob(runDeps)
    expect(firstAttempt.outcome).toBe('retried')
    // The category and "general" landed for real before the simulated
    // failure — "announcements" never did.
    expect(discordServer.writeRequests()).toHaveLength(2)

    const secondAttempt = await runNextJob(runDeps)
    expect(secondAttempt.outcome).toBe('succeeded')

    // Three writes total, not four: the retry found the category and
    // "general" already present and created only what the failed attempt
    // never reached.
    const writes = discordServer.writeRequests()
    expect(writes).toHaveLength(3)
    const names = writes.map((r) => r.body?.['name'])
    expect(names.filter((n) => n === 'Week 1')).toHaveLength(1)
    expect(names.filter((n) => n === 'general')).toHaveLength(1)
    expect(names.filter((n) => n === 'announcements')).toHaveLength(1)
  })

  // SRV-8: a guild holding a category the course does not declare is
  // reported and not deleted — the fake received no delete call of any
  // kind.
  it('reports a category the course does not declare, without deleting it', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [] },
    ])
    discordServer.setGuildChannels(seeded.guildId, [
      {
        id: 'stray-cat',
        type: 4,
        name: 'Leftover From Last Term',
        parent_id: null,
      },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      undeclaredCategories: string[]
    }

    expect(report.undeclaredCategories).toEqual(['Leftover From Last Term'])
    // No DELETE (or any non-GET/POST) call reached the fake at all —
    // structural proof alongside `DiscordRestClient`'s own missing methods.
    expect(discordServer.requests.some((r) => r.method === 'DELETE')).toBe(
      false
    )
    expect(discordServer.requests.some((r) => r.method === 'PATCH')).toBe(false)
    // The stray category is still there.
    expect(
      discordServer
        .writeRequests()
        .every((r) => r.body?.['name'] !== 'Leftover From Last Term')
    ).toBe(true)
  })

  // Finding 2 of the SRV-6..8 rework: a guild can host more than one of this
  // organization's courses at once (one Discord server binding per
  // organization, courses spread across its projects — this repo's own
  // `bot_config.yml` has two courses sharing a server). Scaffolding one
  // course must never report *another* course's own category as
  // undeclared — that is precisely the "hand-delete a live course's
  // channels" outcome SRV-8 exists to prevent.
  it("does not report another course in the same organization's own category as undeclared", async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [] },
    ])

    const otherProject = projects.createProject(
      seeded.organizationId,
      { name: 'Course B Project' },
      testDb.db
    )
    const courseB = courses.createCourse(
      seeded.organizationId,
      {
        projectId: otherProject.id,
        title: 'Course B',
        filePrefix: 'cb',
        enabled: true,
        adminsRole: 'course-b-admins',
        studentsRole: 'course-b-students',
        categories: [{ name: 'Course B Category', channels: [] }],
      },
      testDb.db
    )
    if (!courseB.ok) {
      throw new Error(
        `setup: could not create the second course: ${courseB.conflict.message}`
      )
    }

    // The guild already holds course B's own category, scaffolded some
    // earlier run this test does not need to reproduce.
    discordServer.setGuildChannels(seeded.guildId, [
      {
        id: 'course-b-cat',
        type: 4,
        name: 'Course B Category',
        parent_id: null,
      },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as { undeclaredCategories: string[] }

    expect(report.undeclaredCategories).toEqual([])
  })

  // Finding 3 of the SRV-6..8 rework: SRV-8's "or channel" half — a channel
  // removed from a course's config, inside a category the course (and so
  // the organization) still declares, must be named too, on the same
  // organization-wide basis as `undeclaredCategories` — not silently
  // omitted.
  it('reports a channel no course declares any more, within a category the organization still declares', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
    ])
    discordServer.setGuildChannels(seeded.guildId, [
      { id: 'cat-1', type: 4, name: 'Week 1', parent_id: null },
      { id: 'chan-1', type: 0, name: 'general', parent_id: 'cat-1' },
      // No course declares this any more — say, dropped from the config
      // since the guild was last scaffolded.
      { id: 'chan-2', type: 0, name: 'old-announcements', parent_id: 'cat-1' },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as { undeclaredCategories: string[]; undeclaredChannels: string[] }

    expect(report.undeclaredCategories).toEqual([])
    expect(report.undeclaredChannels).toEqual(['old-announcements'])
    // Named, never removed — same structural proof as `undeclaredCategories`.
    expect(discordServer.requests.some((r) => r.method === 'DELETE')).toBe(
      false
    )
    expect(
      discordServer
        .writeRequests()
        .every((r) => r.body?.['name'] !== 'old-announcements')
    ).toBe(true)
  })

  // A role that does not resolve in the guild is reported rather than
  // silently skipped or guessed at (SRV-2).
  it('reports a role name that does not resolve in the guild, and still creates the category without it', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [] },
    ])
    // Only the admins role resolves — the students role name in the config
    // does not match anything in the guild.
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      unresolvedRoles: string[]
    }

    expect(report.unresolvedRoles).toEqual([seeded.studentsRole])
    // The category was still created — an unresolved role is reported, not
    // fatal.
    const created = discordServer.writeRequests()
    expect(created).toHaveLength(2) // category + temp placeholder
  })

  // Finding 4 of the SRV-6..8 rework: an instructor sets `admins_only: true`
  // on a channel students can already read — this run writes nothing to a
  // pre-existing channel's permissions (SRV-8), so the report must say what
  // is actually true (still readable by students), not echo the
  // declaration. Same one level up for a category: a pre-existing, still
  // public category is never denied `@everyone` by this run either.
  it('reports the observed permission state of a pre-existing channel and category, not the declared one', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'grades', adminsOnly: true }] },
    ])
    // The category was never locked down, and the channel was never made
    // admins-only — both still readable by `@everyone`, whatever the course
    // now declares.
    discordServer.setGuildChannels(seeded.guildId, [
      { id: 'cat-1', type: 4, name: 'Week 1', parent_id: null },
      { id: 'chan-1', type: 0, name: 'grades', parent_id: 'cat-1' },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: {
        status: string
        everyoneDenied: boolean
        establishedByThisRun: boolean
        channels: {
          status: string
          adminsOnly: boolean
          establishedByThisRun: boolean
        }[]
      }[]
    }

    // Nothing was written — both were already present.
    expect(discordServer.writeRequests()).toHaveLength(0)
    expect(report.categories).toEqual([
      expect.objectContaining({
        status: 'already_present',
        everyoneDenied: false,
        establishedByThisRun: false,
        channels: [
          expect.objectContaining({
            status: 'already_present',
            // Declared `admins_only: true`, but this run never touched it —
            // the report says what is actually true: students can still
            // read it.
            adminsOnly: false,
            establishedByThisRun: false,
          }),
        ],
      }),
    ])
  })

  // The job is scoped: a payload naming another organization's course is
  // refused by the repo layer (TEN-2/TEN-5), the same way any other
  // cross-tenant read is.
  it("refuses a payload naming another organization's course", async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [] },
    ])
    const otherOrgId = randomUUID()
    organizations.createOrganization(
      otherOrgId,
      { name: 'Other Org', isPersonal: false },
      testDb.db
    )

    await expect(runScaffold(otherOrgId, seeded.courseId)).rejects.toThrow(
      /not found in this organization/
    )

    // No Discord call was made at all — refused before any REST call.
    expect(discordServer.requests).toHaveLength(0)
  })

  // The first real handler through the queue: enqueue, run one worker pass,
  // and the report is readable afterwards on the job row — the end-to-end
  // path the previous slice's empty registry could not test.
  it('runs end to end through the real queue: enqueue, one worker pass, a readable report', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    const enqueued = jobs.enqueueJob(
      seeded.organizationId,
      {
        kind: DISCORD_SCAFFOLD_JOB_KIND,
        payload: { courseId: seeded.courseId },
        maxAttempts: 3,
      },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register(
      DISCORD_SCAFFOLD_JOB_KIND,
      createDiscordScaffoldHandler({
        discordRestClient: createDiscordRestClient({
          clientId: 'unused',
          clientSecret: 'unused',
          apiBase: discordServer.baseUrl,
          oauthBase: discordServer.baseUrl,
        }),
        botToken: 'bot-token',
      })
    )

    const outcome = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(outcome.outcome).toBe('succeeded')

    const row = jobs.getJob(seeded.organizationId, enqueued.id, testDb.db)
    expect(row?.status).toBe('succeeded')
    const report = JSON.parse(row?.result ?? 'null') as {
      categories: { name: string; status: string }[]
    }
    expect(report.categories).toEqual([
      expect.objectContaining({ name: 'Week 1', status: 'created' }),
    ])

    // Sanity: `courses.getCourse` still resolves the same course this job
    // scaffolded, confirming the queue and the repo layer agree on what ran.
    expect(
      courses.getCourse(seeded.organizationId, seeded.courseId, testDb.db)?.id
    ).toBe(seeded.courseId)
  })
})
