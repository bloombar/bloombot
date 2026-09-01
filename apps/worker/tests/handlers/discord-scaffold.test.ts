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

import { courses, jobs, organizations } from '@bloombot/db'
import { createDiscordRestClient } from '@bloombot/discord-rest'
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
        channels: [
          { name: 'general', status: 'created', adminsOnly: false },
          { name: 'admins', status: 'created', adminsOnly: true },
        ],
      },
      {
        name: 'Week 2',
        status: 'created',
        channels: [{ name: 'temp', status: 'created', adminsOnly: false }],
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
        channels: [
          { name: 'general', status: 'already_present', adminsOnly: false },
        ],
      },
    ])
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
