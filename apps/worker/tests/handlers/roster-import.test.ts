/**
 * `roster.import` (ROST-9..12) — asserted against a real, throwaway
 * database and a loopback fake standing in for Discord's guild-management
 * *and* member-list endpoints (`FakeDiscordGuildServer`). Each test below
 * fails without this slice's code: before it, `apps/worker` had no
 * `createRosterImportHandler`, `@bloombot/schemas` had no `parseRosterCsv`,
 * and `@bloombot/discord-rest` had no `listGuildMembers`.
 *
 * Fixtures are written inline in this file — never a file from `rosters/`
 * or `results/`, which may hold real students' names and emails.
 */

import { randomUUID } from 'node:crypto'

import { jobs, organizations, people } from '@bloombot/db'
import {
  createDiscordRestClient,
  type DiscordRestClient,
} from '@bloombot/discord-rest'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createRosterImportHandler,
  ROSTER_IMPORT_JOB_KIND,
  type RosterImportReport,
} from '../../src/handlers/roster-import.js'
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
const HEADER = 'First,Last,Email,Discord,GitHub'

/** Runs the handler directly (no queue) against `discordServer`. */
async function runImport(
  organizationId: string,
  courseId: string,
  csvText: string,
  options?: {
    categoryChannelCap?: number
    discordRestClient?: DiscordRestClient
  }
): Promise<RosterImportReport> {
  const handler = createRosterImportHandler({
    discordRestClient:
      options?.discordRestClient ??
      createDiscordRestClient({
        clientId: 'unused',
        clientSecret: 'unused',
        apiBase: discordServer.baseUrl,
        oauthBase: discordServer.baseUrl,
      }),
    botToken: 'bot-token',
    ...(options?.categoryChannelCap !== undefined
      ? { categoryChannelCap: options.categoryChannelCap }
      : {}),
  })
  return handler(
    { courseId, csvText },
    {
      organizationId,
      jobId: randomUUID(),
      attempts: 1,
      db: testDb.db,
      logger: createFakeLogger(),
    }
  ) as Promise<RosterImportReport>
}

/** Seed a course with one already-scaffolded numbered student category (CFG-4's own `… - STUDENTS NN` convention) — the guild already holds the category (as an earlier `discordServers.scaffold` run would have left it), empty. */
function seedCourseWithStudentCategory(numbers: number[] = [1]) {
  const categories = numbers.map((n) => ({
    name: `Test Course - STUDENTS ${String(n).padStart(2, '0')}`,
    channels: [],
  }))
  const seeded = seedOrganizationWithBoundCourse(testDb.db, categories)
  discordServer.setGuildChannels(
    seeded.guildId,
    categories.map((c, i) => ({
      id: `cat-${i + 1}`,
      type: 4,
      name: c.name,
      parent_id: null,
    }))
  )
  discordServer.setGuildRoles(seeded.guildId, [
    { id: 'role-admins', name: seeded.adminsRole },
    { id: 'role-students', name: seeded.studentsRole },
  ])
  return seeded
}

describe('roster.import handler', () => {
  // ROST-9: a CSV with two good rows and one malformed row imports the two
  // and reports the third with its own line number.
  it('imports the rows that parse and reports a malformed row with its line number', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedCourseWithStudentCategory()
    discordServer.setGuildMembers(seeded.guildId, [
      { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      { user: { id: 'snowflake-grace', username: 'gracehopper' } },
    ])

    const csv = [
      HEADER,
      'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      'Alan,Turing,alan@example.edu,,aturing', // no Discord handle — malformed
      'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
    ].join('\n')

    const report = await runImport(seeded.organizationId, seeded.courseId, csv)

    expect(report.parseErrors).toEqual([expect.objectContaining({ line: 3 })])
    expect(report.channelsCreated).toHaveLength(2)
    expect(report.channelsCreated.map((c) => c.channelName)).toEqual([
      'ada',
      'grace',
    ])
  })

  describe('ROST-10 — person resolution', () => {
    it('merges a resolved row onto an existing person, without overwriting a field a surface already proved, and creates a new person for an unmatched handle', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
        { user: { id: 'snowflake-grace', username: 'gracehopper' } },
      ])

      // Ada already has a person row, resolved through the same
      // snowflake-keyed Discord identity a live message from her would
      // create (PPL-3) — this is the "handle matches an existing person"
      // case. Her display name is already set directly (`overwriteRosterFields`,
      // simulating a surface that already proved it, e.g. her own Discord
      // profile) — the roster's own value for it must not overwrite that
      // (PPL-4), even though her `email` is still null and so *should* be
      // filled in.
      const existingPerson = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-ada' },
        testDb.db
      )
      people.overwriteRosterFields(
        seeded.organizationId,
        existingPerson.id,
        { displayName: 'Ada (from Discord)' },
        testDb.db
      )

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
        'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      // Grace's handle matched nobody — a new person was created for her.
      expect(report.peopleCreated).toHaveLength(1)
      expect(report.peopleCreated[0]?.discord).toBe('gracehopper')

      // Ada's own row was merged onto, not duplicated.
      expect(report.peopleMerged).toEqual([
        expect.objectContaining({
          discord: 'adalovelace',
          personId: existingPerson.id,
        }),
      ])
      const adaAfter = people.getPerson(
        seeded.organizationId,
        existingPerson.id,
        testDb.db
      )
      expect(adaAfter?.displayName).toBe('Ada (from Discord)') // untouched — PPL-4
      expect(adaAfter?.email).toBe('ada@example.edu') // filled in — it was null
    })

    it('keeps a row whose handle does not resolve in the guild under a stable synthetic identity, so a second import recognizes the same person', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      // No members seeded at all — nobody resolves.

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      const first = await runImport(seeded.organizationId, seeded.courseId, csv)
      expect(first.peopleCreated).toHaveLength(1)

      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )
      // Same person recognized again — merged, not created a second time.
      expect(second.peopleMerged).toHaveLength(1)
      expect(second.peopleMerged[0]?.personId).toBe(
        first.peopleCreated[0]?.personId
      )
    })
  })

  describe('ROST-11 — per-student channels, batched around the category cap', () => {
    it('fills the first category to the cap, then spills into the second, in order', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory([1, 2])
      const cap = 3
      // N + 2 = 5 students, cap = 3: category 01 gets 3, category 02 gets 2.
      const rows = ['ada', 'brianna', 'carlos', 'diego', 'elena'].map(
        (name) => `${name},L,${name}@example.edu,${name},gh-${name}`
      )
      const csv = [HEADER, ...rows].join('\n')
      discordServer.setGuildMembers(
        seeded.guildId,
        rows.map((_, i) => ({
          user: {
            id: `snowflake-${i}`,
            username: rows[i]?.split(',')[3] ?? '',
          },
        }))
      )

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv,
        { categoryChannelCap: cap }
      )

      expect(report.channelsNotCreated).toEqual([])
      const byCategory = new Map<string, string[]>()
      for (const c of report.channelsCreated) {
        byCategory.set(c.category, [
          ...(byCategory.get(c.category) ?? []),
          c.channelName,
        ])
      }
      expect(byCategory.get('Test Course - STUDENTS 01')).toEqual([
        'ada',
        'brianna',
        'carlos',
      ])
      expect(byCategory.get('Test Course - STUDENTS 02')).toEqual([
        'diego',
        'elena',
      ])
    })

    // Idempotence: running the same roster twice creates no second channel
    // for anyone — the fake must slug names the way Discord does (this
    // fake's own `slugifyChannelName`, the same as the scaffold slice's), or
    // this test would pass for the wrong reason.
    it('creates no second channel on a re-run of the same roster', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
        'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
      ].join('\n')
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
        { user: { id: 'snowflake-grace', username: 'gracehopper' } },
      ])

      await runImport(seeded.organizationId, seeded.courseId, csv)
      const createCallsAfterFirstRun = discordServer.writeRequests().length
      expect(createCallsAfterFirstRun).toBe(2)

      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(discordServer.writeRequests()).toHaveLength(
        createCallsAfterFirstRun
      )
      expect(second.channelsCreated).toEqual([])
      expect(second.channelsAlreadyPresent).toHaveLength(2)
    })
  })

  // ROST-12: a handle that does not resolve in the guild is reported and
  // does not stop the run — the rest of the roster still imports, and the
  // student's channel is still created (admin-only, since the individual
  // grant could not be resolved).
  it('reports a handle that does not resolve, without stopping the rest of the roster', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedCourseWithStudentCategory()
    discordServer.setGuildMembers(seeded.guildId, [
      { user: { id: 'snowflake-grace', username: 'gracehopper' } },
      // "adalovelace" is not a member of this guild at all.
    ])

    const csv = [
      HEADER,
      'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
    ].join('\n')

    const report = await runImport(seeded.organizationId, seeded.courseId, csv)

    expect(report.unresolvedHandles).toEqual([
      { line: 2, discord: 'adalovelace', email: 'ada@example.edu' },
    ])
    // Both channels still created — the unresolved handle did not abort
    // Ada's own row, or Grace's after it.
    expect(report.channelsCreated.map((c) => c.channelName)).toEqual([
      'ada',
      'grace',
    ])
  })

  // The job is scoped: a payload naming another organization's course is
  // refused by the repo layer (TEN-2/TEN-5).
  it("refuses a payload naming another organization's course", async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedCourseWithStudentCategory()
    const otherOrgId = randomUUID()
    organizations.createOrganization(
      otherOrgId,
      { name: 'Other Org', isPersonal: false },
      testDb.db
    )

    await expect(
      runImport(otherOrgId, seeded.courseId, [HEADER].join('\n'))
    ).rejects.toThrow(/not found in this organization/)

    expect(discordServer.requests).toHaveLength(0)
  })

  // End to end through the real queue: enqueue, one worker pass, a readable
  // report on the job row.
  it('runs end to end through the real queue: enqueue, one worker pass, a readable report', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedCourseWithStudentCategory()
    discordServer.setGuildMembers(seeded.guildId, [
      { user: { id: 'snowflake-ada', username: 'adalovelace' } },
    ])
    const csv = [HEADER, 'Ada,Lovelace,ada@example.edu,adalovelace,adal'].join(
      '\n'
    )

    const enqueued = jobs.enqueueJob(
      seeded.organizationId,
      {
        kind: ROSTER_IMPORT_JOB_KIND,
        payload: { courseId: seeded.courseId, csvText: csv },
        maxAttempts: 3,
      },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register(
      ROSTER_IMPORT_JOB_KIND,
      createRosterImportHandler({
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
    const report = JSON.parse(row?.result ?? 'null') as RosterImportReport
    expect(report.channelsCreated).toEqual([
      expect.objectContaining({ channelName: 'ada' }),
    ])
  })
})
