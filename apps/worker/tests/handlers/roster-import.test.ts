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

import {
  accounts,
  courses,
  discordServers,
  enrolments,
  jobs,
  organizations,
  people,
} from '@bloombot/db'
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

/** Every `channelsCreated`/`channelsAlreadyPresent` entry a run reported, keyed by email — order-independent, since the whole point of ROST-14's scheme is that a row's name never depends on where it sits in the file. Shared by the ROST-14 and ROST-16 describe blocks below. */
function namesByEmail(report: RosterImportReport): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of [
    ...report.channelsCreated,
    ...report.channelsAlreadyPresent,
  ]) {
    out[entry.email] = entry.channelName
  }
  return out
}

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

  // Rework finding 4: one failed create (a 429, 403 or 400) must not abort
  // the whole import — before this fix, `createGuildChannel` had no
  // try/catch, so a single failure threw straight out of the handler.
  it('catches a failed channel create for one row and keeps importing the rest of the roster', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedCourseWithStudentCategory()
    discordServer.setGuildMembers(seeded.guildId, [
      { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      { user: { id: 'snowflake-grace', username: 'gracehopper' } },
    ])
    // Ada's own create fails; Grace's — the row after her — must still run.
    discordServer.failNextChannelCreate(429, { message: 'rate limited' })

    const csv = [
      HEADER,
      'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
    ].join('\n')

    const report = await runImport(seeded.organizationId, seeded.courseId, csv)

    expect(report.channelsFailed).toEqual([
      expect.objectContaining({ line: 2, email: 'ada@example.edu' }),
    ])
    expect(report.channelsFailed[0]?.reason).toContain('429')
    // Grace's row still imported — the failure did not abort the run.
    expect(report.channelsCreated.map((c) => c.channelName)).toEqual(['grace'])
  })

  describe('rework finding 5 — an already-present channel is repaired for a newly-resolved member', () => {
    it('grants a late-joining student access on their already-existing channel, rather than leaving it admin-only forever', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      // First import: Ada has not joined the server yet — her handle does
      // not resolve, so her channel is created admin-only.
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const first = await runImport(seeded.organizationId, seeded.courseId, csv)
      expect(first.channelsCreated).toHaveLength(1)
      expect(first.unresolvedHandles).toHaveLength(1)
      const firstCreateBody = discordServer.requests.find(
        (r) => r.method === 'POST'
      )?.body
      expect(
        (firstCreateBody?.['permission_overwrites'] as { type: number }[]).some(
          (o) => o.type === 1
        )
      ).toBe(false) // No member overwrite yet — nobody to grant it to.

      // Ada has since joined the server — re-importing the same roster
      // now resolves her handle.
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])

      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(second.channelAccessGranted).toEqual([
        expect.objectContaining({ line: 2, email: 'ada@example.edu' }),
      ])
      expect(second.channelsAlreadyPresent).toEqual([])
      expect(second.channelsCreated).toEqual([])

      // Structural proof, extending the same "no mutating verb" discipline
      // `discord-scaffold.test.ts` already holds SRV-8 to: no DELETE or
      // PATCH ever reached the fake, and the one PUT that did matches
      // exactly the narrow permission-overwrite path — never a general
      // channel edit.
      expect(discordServer.requests.some((r) => r.method === 'DELETE')).toBe(
        false
      )
      expect(discordServer.requests.some((r) => r.method === 'PATCH')).toBe(
        false
      )
      const putRequests = discordServer.requests.filter(
        (r) => r.method === 'PUT'
      )
      expect(putRequests).toHaveLength(1)
      expect(putRequests[0]?.path).toMatch(
        /^\/channels\/[^/]+\/permissions\/snowflake-ada$/
      )
    })

    it('does not re-grant a member who already has access, on a further re-import', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      // Ada already resolves on the very first run, so her channel is
      // created *with* her own member overwrite already baked in.
      await runImport(seeded.organizationId, seeded.courseId, csv)
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(second.channelAccessGranted).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([
        expect.objectContaining({ line: 2, email: 'ada@example.edu' }),
      ])
      // No PUT at all — nothing needed repairing.
      expect(discordServer.requests.some((r) => r.method === 'PUT')).toBe(false)
    })

    it('catches a failed access repair for one row and keeps importing the rest of the roster', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      await runImport(seeded.organizationId, seeded.courseId, csv) // admin-only, unresolved

      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])
      discordServer.failNextPermissionPut(403, { message: 'Missing Access' })

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelAccessGrantFailed).toEqual([
        expect.objectContaining({ line: 2, email: 'ada@example.edu' }),
      ])
      expect(report.channelAccessGrantFailed[0]?.reason).toContain('403')
    })
  })

  // ROST-14: two different rows' emails slug to the same channel name
  // (`ada@school.edu`/`ada@gmail.com` both to `ada`) — every row still gets
  // a channel; the second is numbered rather than refused one, and reported
  // so an instructor can still tell the two rows apart.
  describe('ROST-14 — every row gets a channel, disambiguated by domain, never by row position', () => {
    it('disambiguates two rows whose emails slug to the same name by domain, not position', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada-1', username: 'ada-school' } },
        { user: { id: 'snowflake-ada-2', username: 'ada-gmail' } },
      ])

      const csv = [
        HEADER,
        'Ada,S,ada@school.edu,ada-school,gh1',
        'Ada,G,ada@gmail.com,ada-gmail,gh2',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(namesByEmail(report)).toEqual({
        'ada@school.edu': 'ada-school-edu',
        'ada@gmail.com': 'ada-gmail-com',
      })
      expect(report.channelNameDisambiguated).toEqual([
        expect.objectContaining({
          line: 2,
          email: 'ada@school.edu',
          baseChannelName: 'ada',
          channelName: 'ada-school-edu',
          sharesSlugWith: ['ada@gmail.com'],
        }),
        expect.objectContaining({
          line: 3,
          email: 'ada@gmail.com',
          baseChannelName: 'ada',
          channelName: 'ada-gmail-com',
          sharesSlugWith: ['ada@school.edu'],
        }),
      ])
      // Both rows got a channel — neither was refused one, and neither kept
      // the bare `ada` (the SPEC's own worked example: both change).
      expect(report.channelsCreated).toHaveLength(2)
    })

    // This is the test that would have caught the defect a positional
    // ordinal scheme had: reversing the two colliding rows must not change
    // either name. It fails against `e4a2507` (the reverted ordinal draft),
    // where the row that comes first always keeps the bare name and the
    // other is numbered — so swapping the rows swaps which student gets
    // which channel.
    it('produces the identical two names regardless of which row comes first', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada-1', username: 'ada-school' } },
        { user: { id: 'snowflake-ada-2', username: 'ada-gmail' } },
      ])

      const forward = [
        HEADER,
        'Ada,S,ada@school.edu,ada-school,gh1',
        'Ada,G,ada@gmail.com,ada-gmail,gh2',
      ].join('\n')
      const reversed = [
        HEADER,
        'Ada,G,ada@gmail.com,ada-gmail,gh2',
        'Ada,S,ada@school.edu,ada-school,gh1',
      ].join('\n')

      const forwardReport = await runImport(
        seeded.organizationId,
        seeded.courseId,
        forward
      )
      // Fresh database and guild for the reversed run — this test is about
      // what one import derives from a given set of addresses, not about
      // two imports of the same file.
      testDb.cleanup()
      await discordServer.stop()
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const reseeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(reseeded.guildId, [
        { user: { id: 'snowflake-ada-1', username: 'ada-school' } },
        { user: { id: 'snowflake-ada-2', username: 'ada-gmail' } },
      ])
      const reversedReport = await runImport(
        reseeded.organizationId,
        reseeded.courseId,
        reversed
      )

      expect(namesByEmail(reversedReport)).toEqual(namesByEmail(forwardReport))
    })

    // Deliberately a *colliding* third row, not merely an unrelated one: an
    // unrelated row never shifted anybody's ordinal even under the reverted
    // positional scheme, so it would have passed for the wrong reason. What
    // actually needs proving is that a third address sharing the same slug,
    // inserted ahead of an existing colliding pair, does not perturb the
    // names those two already had — the identical-roster reorder test above
    // covers pure reordering; this one covers a change in *membership*.
    it("changes neither existing student's name when a third colliding row is inserted ahead of them", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada-1', username: 'ada-school' } },
        { user: { id: 'snowflake-ada-2', username: 'ada-gmail' } },
      ])

      const withoutExtra = [
        HEADER,
        'Ada,S,ada@school.edu,ada-school,gh1',
        'Ada,G,ada@gmail.com,ada-gmail,gh2',
      ].join('\n')
      const withExtra = [
        HEADER,
        'Ada,H,ada@hotmail.com,ada-hotmail,gh0',
        'Ada,S,ada@school.edu,ada-school,gh1',
        'Ada,G,ada@gmail.com,ada-gmail,gh2',
      ].join('\n')

      const without = await runImport(
        seeded.organizationId,
        seeded.courseId,
        withoutExtra
      )
      testDb.cleanup()
      await discordServer.stop()
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const reseeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(reseeded.guildId, [
        { user: { id: 'snowflake-ada-0', username: 'ada-hotmail' } },
        { user: { id: 'snowflake-ada-1', username: 'ada-school' } },
        { user: { id: 'snowflake-ada-2', username: 'ada-gmail' } },
      ])
      const withIt = await runImport(
        reseeded.organizationId,
        reseeded.courseId,
        withExtra
      )

      expect(namesByEmail(withIt)['ada@school.edu']).toBe(
        namesByEmail(without)['ada@school.edu']
      )
      expect(namesByEmail(withIt)['ada@gmail.com']).toBe(
        namesByEmail(without)['ada@gmail.com']
      )
      // The third address got its own name too, in the same one shared
      // namespace, not something disjoint from the other two.
      expect(namesByEmail(withIt)['ada@hotmail.com']).toBe('ada-hotmail-com')
    })

    it('treats two rows for the same address, spelled with different letter case, as one student — one channel, not two', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
        'Ada,Lovelace,ADA@EXAMPLE.EDU,adalovelace,adal',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelsCreated).toHaveLength(1)
      expect(report.channelsCreated[0]?.channelName).toBe('ada')
      expect(report.channelNameDisambiguated).toEqual([])
    })

    it('disambiguates correctly, in either order, when a generated name would otherwise land on a real address', async () => {
      // Three addresses: two slug to `ada` and would disambiguate to
      // `ada-school-edu`/`ada-gmail-com` at level 2; the third's own local
      // part is literally `ada-school-edu` — exactly the name
      // `ada@school.edu` would otherwise land on. Both orderings must
      // resolve every address to a name nothing else in the roster shares,
      // and the address that already owned the name outright must never be
      // the one that moves.
      const rowsFor = (emails: string[]): string[] =>
        emails.map((email, i) => `Ada,${i},${email},ada-${i},gh${i}`)

      // Each call gets its own fresh database and guild — this test is
      // about what one import derives from a given set of addresses, not
      // about two imports of the same file — but leaves the *last* one
      // standing for the shared `afterEach` above to tear down, rather than
      // stopping it here too.
      let priorServer: FakeDiscordGuildServer | undefined
      async function runWithOrder(emails: string[]) {
        if (priorServer) await priorServer.stop()
        testDb = createTestDatabase()
        discordServer = await FakeDiscordGuildServer.start()
        const seeded = seedCourseWithStudentCategory()
        discordServer.setGuildMembers(
          seeded.guildId,
          emails.map((_, i) => ({
            user: { id: `snowflake-${i}`, username: `ada-${i}` },
          }))
        )
        const csv = [HEADER, ...rowsFor(emails)].join('\n')
        const report = await runImport(
          seeded.organizationId,
          seeded.courseId,
          csv
        )
        priorServer = discordServer
        return namesByEmail(report)
      }

      const addresses = [
        'ada@school.edu',
        'ada@gmail.com',
        'ada-school-edu@evil.edu',
      ]

      const forward = await runWithOrder(addresses)
      const reversed = await runWithOrder([...addresses].reverse())

      // Every address got its own name, nothing shared, in both orders.
      expect(new Set(Object.values(forward)).size).toBe(3)
      expect(forward).toEqual(reversed)
      // The address that already owned `ada-school-edu` outright (level 1)
      // was never touched — it is `ada@school.edu`, escalating to avoid
      // that name, that had to move to a level-3 hash instead.
      expect(forward['ada-school-edu@evil.edu']).toBe('ada-school-edu')
      expect(forward['ada@gmail.com']).toBe('ada-gmail-com')
      expect(forward['ada@school.edu']).toMatch(/^ada-[0-9a-f]{8}$/)
    })

    // Round 2's must-fix 1: `normalizeChannelName` collapses whitespace to
    // `-`, so these two addresses slug identically and share a domain — they
    // tie at level 1 (identical local part) *and* level 2 (identical
    // domain), leaving level 3's hash of the whole address (`levelThreeName`)
    // as the only thing that tells them apart. Measured, before that level
    // existed: row 1 created one channel, row 2 was filed
    // `channelsAlreadyPresent` (a false "already set up"), and a later
    // import granted both students the one channel row 1 made.
    it('gives two addresses distinct names even when they slug identically and share a domain', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-1', username: 'row-one' } },
        { user: { id: 'snowflake-2', username: 'row-two' } },
      ])

      const csv = [
        HEADER,
        'Ada,One,ada b@x.edu,row-one,gh1',
        'Ada,Two,ada-b@x.edu,row-two,gh2',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      // Both got a channel, and the two channels are actually different —
      // not one created and the other misreported as already present.
      expect(report.channelsCreated).toHaveLength(2)
      const names = report.channelsCreated.map((c) => c.channelName)
      expect(new Set(names).size).toBe(2)
      expect(report.channelsAlreadyPresent).toEqual([])

      // A re-import does not merge them onto one channel either — each
      // address's own fingerprinted name is stable and distinct.
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )
      expect(second.channelsCreated).toEqual([])
      expect(second.channelsAlreadyPresent).toHaveLength(2)
      const secondChannels = discordServer.guildChannelsFor(seeded.guildId) as {
        name: string
        permission_overwrites: { id: string; type: number }[]
      }[]
      for (const channelName of names) {
        const channel = secondChannels.find((c) => c.name === channelName)
        const individualGrants =
          channel?.permission_overwrites.filter((o) => o.type === 1) ?? []
        // Exactly one student ever has access to each of the two channels.
        expect(individualGrants).toHaveLength(1)
      }
    })

    // Round 3's own must-fix: the exact hang the coordinator measured. A
    // round-2 draft escalated one domain *label* at a time and had no
    // ceiling — `normalizeChannelName` collapses both `.` and `-` to the
    // same `-`, so `my.school.edu` and `my-school.edu` produce the
    // identical string at every label boundary, and that loop never
    // converged (reproduced against the real handler: three rows, killed at
    // 120s, ~117% CPU). This round's own scheme escalates the *whole*
    // domain in one step (level 2) and falls back to a hash of the whole
    // address (level 3) rather than looping over labels at all, so the
    // identical pair below resolves in a small, fixed number of steps.
    it('resolves two addresses whose domains differ only by a separator, without hanging', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-1', username: 'row-one' } },
        { user: { id: 'snowflake-2', username: 'row-two' } },
      ])

      const csv = [
        HEADER,
        'Ada,One,ada@my.school.edu,row-one,gh1',
        'Ada,Two,ada@my-school.edu,row-two,gh2',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelsCreated).toHaveLength(2)
      const names = report.channelsCreated.map((c) => c.channelName)
      expect(new Set(names).size).toBe(2)
    })

    // Round 3's own must-fix: the previous scheme's disambiguator grew with
    // the local part's own length (four base-36 digits *per character*), so
    // a merely 26-character local part could exceed Discord's 100-character
    // limit before the suffix was even added. This scheme's own
    // disambiguators are fixed-length (a full domain, or a short hash), so
    // only an implausibly long local part can still push a name over the
    // limit — handled by truncating the local part itself, never the
    // disambiguator (`composeChannelName`'s own doc comment).
    it('caps a generated name at 100 characters by truncating the local part, never the disambiguator', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-1', username: 'row-one' } },
      ])

      const longLocalPart = 'a'.repeat(120)
      const csv = [
        HEADER,
        `Ada,Long,${longLocalPart}@example.edu,row-one,gh1`,
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelsCreated).toHaveLength(1)
      const created = report.channelsCreated[0]
      expect(created?.channelName.length).toBeLessThanOrEqual(100)
      // The fake enforces Discord's own real limit — a name over it would
      // have come back as a failed create, not a silently-accepted one.
      expect(report.channelsFailed).toEqual([])
    })

    it('re-imports an unchanged colliding roster without creating or renaming anything', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada-1', username: 'ada-school' } },
        { user: { id: 'snowflake-ada-2', username: 'ada-gmail' } },
      ])
      const csv = [
        HEADER,
        'Ada,S,ada@school.edu,ada-school,gh1',
        'Ada,G,ada@gmail.com,ada-gmail,gh2',
      ].join('\n')

      const first = await runImport(seeded.organizationId, seeded.courseId, csv)
      const createCallsAfterFirstRun = discordServer.writeRequests().length

      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(discordServer.writeRequests()).toHaveLength(
        createCallsAfterFirstRun
      )
      expect(second.channelsCreated).toEqual([])
      expect(namesByEmail(second)).toEqual(namesByEmail(first))
    })

    it('gives a disambiguated channel the same @everyone deny, admins-role grant and individual student grant as an unsuffixed one', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada-1', username: 'ada-school' } },
        { user: { id: 'snowflake-ada-2', username: 'ada-gmail' } },
      ])
      const csv = [
        HEADER,
        'Ada,S,ada@school.edu,ada-school,gh1',
        'Ada,G,ada@gmail.com,ada-gmail,gh2',
      ].join('\n')

      await runImport(seeded.organizationId, seeded.courseId, csv)

      const channels = discordServer.guildChannelsFor(seeded.guildId) as {
        name: string
        permission_overwrites: { id: string; type: number; deny: string }[]
      }[]
      const first = channels.find((c) => c.name === 'ada-school-edu')
      const second = channels.find((c) => c.name === 'ada-gmail-com')
      expect(first).toBeDefined()
      expect(second).toBeDefined()

      const overwriteTargets = (
        overwrites: { id: string; type: number }[]
      ): string[] => overwrites.map((o) => o.id).sort()
      expect(overwriteTargets(first!.permission_overwrites)).toEqual(
        [seeded.guildId, 'role-admins', 'snowflake-ada-1'].sort()
      )
      expect(overwriteTargets(second!.permission_overwrites)).toEqual(
        [seeded.guildId, 'role-admins', 'snowflake-ada-2'].sort()
      )
    })
  })

  describe('ROST-16 — a channel is never handed to a student it does not belong to', () => {
    it('still matches an existing channel that grants nobody but the expected roles — the ordinary, non-conflicting case', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        {
          id: 'chan-ada',
          type: 0,
          name: 'ada',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
          ],
        },
      ])

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelOwnershipConflicts).toEqual([])
      expect(report.channelAccessGranted).toEqual([
        expect.objectContaining({ channelName: 'ada' }),
      ])
    })

    // Round 2's must-fix 2: a grant the platform did not put there and does
    // not recognize (a teaching assistant, added by hand) must not evict the
    // student whose channel it actually is — the TA's id resolves for no row
    // of this roster at all, so it is not a rival owner.
    it('does not refuse a match because of a hand-added grant that belongs to nobody on this roster', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
        { user: { id: 'snowflake-ta', username: 'the-ta' } },
      ])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        {
          id: 'chan-ada',
          type: 0,
          name: 'ada',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
            // A teaching assistant an instructor granted access by hand —
            // not a row on this roster at all.
            { id: 'snowflake-ta', type: 1, allow: '3072', deny: '0' },
          ],
        },
      ])

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelOwnershipConflicts).toEqual([])
      expect(report.channelAccessGranted).toEqual([
        expect.objectContaining({ channelName: 'ada' }),
      ])
      // The TA's own grant survives — nothing this run does removes an
      // overwrite it did not put there.
      const channels = discordServer.guildChannelsFor(seeded.guildId) as {
        id: string
        permission_overwrites: { id: string }[]
      }[]
      const chanAda = channels.find((c) => c.id === 'chan-ada')
      expect(chanAda?.permission_overwrites.map((o) => o.id)).toContain(
        'snowflake-ta'
      )
    })

    // Round 2's must-fix 2, second half: a row whose own handle never
    // resolved identifies no rival owner at all — refusing its own match
    // would evict a student the platform cannot even currently name, on the
    // strength of nothing.
    it('never refuses an unresolved row its own existing channel, even when that channel already grants another roster member', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      // "alice" resolves; "ada-renamed" (this row's own handle) does not —
      // as if Ada renamed her Discord account since the last import.
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-alice', username: 'alice' } },
      ])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        {
          id: 'chan-ada',
          type: 0,
          name: 'ada',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
            { id: 'snowflake-alice', type: 1, allow: '3072', deny: '0' },
          ],
        },
        {
          id: 'chan-alice',
          type: 0,
          name: 'alice',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
            { id: 'snowflake-alice', type: 1, allow: '3072', deny: '0' },
          ],
        },
      ])

      const csv = [
        HEADER,
        'Alice,A,alice@keep.edu,alice,gh-a',
        'Ada,Lovelace,ada@example.edu,ada-renamed,gh-b',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.unresolvedHandles).toEqual([
        expect.objectContaining({ discord: 'ada-renamed' }),
      ])
      expect(report.channelOwnershipConflicts).toEqual([])
      expect(report.channelsCreated).toEqual([])
      expect(report.channelsAlreadyPresent).toEqual([
        expect.objectContaining({
          email: 'alice@keep.edu',
          channelName: 'alice',
        }),
        expect.objectContaining({
          email: 'ada@example.edu',
          channelName: 'ada',
        }),
      ])
    })

    // The genuine case this guard exists for: the member already granted is
    // resolved for a *different row of this same roster* — a real rival.
    it('refuses a match granting a different roster member, and derives a fallback name from its own address', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-alice', username: 'alice' } },
        { user: { id: 'snowflake-ada-new', username: 'ada-new' } },
      ])
      // A channel named `ada` already exists, granting Alice — who is a
      // real row on *this* roster, just not the one this name belongs to.
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        {
          id: 'chan-ada',
          type: 0,
          name: 'ada',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
            { id: 'snowflake-alice', type: 1, allow: '3072', deny: '0' },
          ],
        },
        {
          id: 'chan-alice',
          type: 0,
          name: 'alice',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
            { id: 'snowflake-alice', type: 1, allow: '3072', deny: '0' },
          ],
        },
      ])

      const csv = [
        HEADER,
        'Alice,A,alice@keep.edu,alice,gh-a',
        'Ada,New,ada@newmail.edu,ada-new,gh-b',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelOwnershipConflicts).toEqual([
        {
          line: 3,
          email: 'ada@newmail.edu',
          conflictingChannelName: 'ada',
          newChannelName: 'ada-newmail-edu',
        },
      ])
      expect(report.channelsCreated).toEqual([
        expect.objectContaining({
          email: 'ada@newmail.edu',
          channelName: 'ada-newmail-edu',
        }),
      ])
      expect(report.channelAccessGranted).toEqual([]) // Alice's own channel was not touched.

      const channels = discordServer.guildChannelsFor(seeded.guildId) as {
        id: string
        permission_overwrites: unknown[]
      }[]
      const original = channels.find((c) => c.id === 'chan-ada')
      expect(original?.permission_overwrites).toHaveLength(3)
    })

    // Round 2's must-fix 3: the fallback name is derived from the row's own
    // address, so a second import of the *same* roster (Alice's channel
    // still granting her, still colliding by name) lands on the identical
    // fallback name and re-adopts the channel this run already created,
    // rather than creating a second one on every run.
    it('re-adopts its own conflict-fallback channel on a re-import, rather than creating another', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-alice', username: 'alice' } },
        { user: { id: 'snowflake-ada-new', username: 'ada-new' } },
      ])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        {
          id: 'chan-ada',
          type: 0,
          name: 'ada',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
            { id: 'snowflake-alice', type: 1, allow: '3072', deny: '0' },
          ],
        },
        {
          id: 'chan-alice',
          type: 0,
          name: 'alice',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
            { id: 'snowflake-alice', type: 1, allow: '3072', deny: '0' },
          ],
        },
      ])
      const csv = [
        HEADER,
        'Alice,A,alice@keep.edu,alice,gh-a',
        'Ada,New,ada@newmail.edu,ada-new,gh-b',
      ].join('\n')

      const first = await runImport(seeded.organizationId, seeded.courseId, csv)
      expect(first.channelsCreated).toHaveLength(1)
      const createCallsAfterFirstRun = discordServer.writeRequests().length

      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(second.channelsCreated).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([
        expect.objectContaining({
          email: 'alice@keep.edu',
          channelName: 'alice',
        }),
        expect.objectContaining({
          email: 'ada@newmail.edu',
          channelName: 'ada-newmail-edu',
        }),
      ])
      expect(discordServer.writeRequests()).toHaveLength(
        createCallsAfterFirstRun
      )
    })

    // Round 2's honesty finding: this is not a defect this slice can close
    // (`ChannelOrphanedEntry`'s own doc comment), but it must not be silent.
    // Removing a colliding row frees the bare name for the address that
    // shared it — the same mechanism a roster "split" across two imports
    // (a merged file that used to include both `ada`s, now imported without
    // one of them) produces. The freed name is a genuinely new channel; the
    // student's previous one is left behind, still granting them.
    // Round 2's must-fix 1 (second half): `channelBelongsToSomeoneElse` used
    // to read the channel list `listGuildChannels` returned at the top of
    // the run, never updated after a `grantChannelMemberAccess` call — so a
    // grant this same run made moments earlier, for a different row, was
    // invisible to the very next row's own ownership check.
    it("keeps a channel's own permissions current within one run, so a grant just made for one row is not invisible to the very next row's ownership check", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-x', username: 'ada-x' } },
        { user: { id: 'snowflake-y', username: 'ada-y' } },
      ])
      // A channel already exists, admin-only — as if created before either
      // student had joined the server.
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        {
          id: 'chan-ada',
          type: 0,
          name: 'ada',
          parent_id: 'cat-1',
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
            { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
          ],
        },
      ])
      // Two rows for the same address (a duplicate, mistakenly given two
      // different Discord handles) — both now resolve, to two different
      // real members. Both target the identical, already-existing `ada`
      // channel: `assignChannelNames` treats one address as one name.
      const csv = [
        HEADER,
        'Ada,X,ada@example.edu,ada-x,gh1',
        'Ada,Y,ada@example.edu,ada-y,gh2',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      // The first row's own grant repairs the channel; the second row's own
      // grant must be refused — on the strength of the *first* row's own
      // grant, which exists only because this run just made it moments
      // earlier.
      expect(report.channelAccessGranted).toEqual([
        expect.objectContaining({
          email: 'ada@example.edu',
          channelName: 'ada',
        }),
      ])
      expect(report.channelOwnershipConflicts).toEqual([
        expect.objectContaining({
          email: 'ada@example.edu',
          conflictingChannelName: 'ada',
        }),
      ])
      const channels = discordServer.guildChannelsFor(seeded.guildId) as {
        name: string
        permission_overwrites: { id: string; type: number }[]
      }[]
      const chanAda = channels.find((c) => c.name === 'ada')
      const individualGrants =
        chanAda?.permission_overwrites.filter((o) => o.type === 1) ?? []
      // Only the first row's own member ever got access to this channel.
      expect(individualGrants.map((o) => o.id)).toEqual(['snowflake-x'])
    })

    it('reports an orphaned channel when removing a colliding row frees the bare name for the remaining student', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada-a', username: 'ada-a' } },
        { user: { id: 'snowflake-ada-b', username: 'ada-b' } },
      ])
      const firstCsv = [
        HEADER,
        'Ada,A,ada@a.edu,ada-a,gh-a',
        'Ada,B,ada@b.edu,ada-b,gh-b',
      ].join('\n')
      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        firstCsv
      )
      expect(namesByEmail(first)).toEqual({
        'ada@a.edu': 'ada-a-edu',
        'ada@b.edu': 'ada-b-edu',
      })

      // The second import's roster no longer includes `ada@b.edu` — `ada@a.edu`
      // is now the only address slugging to `ada`, so it is entitled to the
      // bare name again.
      const secondCsv = [HEADER, 'Ada,A,ada@a.edu,ada-a,gh-a'].join('\n')
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        secondCsv
      )

      expect(namesByEmail(second)['ada@a.edu']).toBe('ada')
      expect(second.channelsOrphaned).toEqual([
        {
          line: 2,
          email: 'ada@a.edu',
          previousChannelName: 'ada-a-edu',
          newChannelName: 'ada',
        },
      ])
      // All three text channels still exist — `ada-b-edu` (Ada B's own,
      // never touched by the second import at all) and both of Ada A's,
      // old and new. Nothing was deleted or migrated, only reported.
      const channels = discordServer.guildChannelsFor(seeded.guildId) as {
        name: string
        type: number
      }[]
      expect(
        channels
          .filter((c) => c.type === 0)
          .map((c) => c.name)
          .sort()
      ).toEqual(['ada', 'ada-a-edu', 'ada-b-edu'])
    })

    // Round 3's own must-fix: the orphan push used to happen before the
    // `createGuildChannel` call, so a failed create reported *both*
    // `channelsFailed` and `channelsOrphaned` — telling the instructor to
    // go reconcile a stale channel against a new one that was never
    // actually made. It must only fire once the create really succeeds.
    it('does not report an orphan when the new channel fails to create', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada-a', username: 'ada-a' } },
        { user: { id: 'snowflake-ada-b', username: 'ada-b' } },
      ])
      const firstCsv = [
        HEADER,
        'Ada,A,ada@a.edu,ada-a,gh-a',
        'Ada,B,ada@b.edu,ada-b,gh-b',
      ].join('\n')
      await runImport(seeded.organizationId, seeded.courseId, firstCsv)

      // The second import's roster is down to just `ada@a.edu` again, so it
      // is entitled to the bare `ada` — but this run's own create for it is
      // made to fail.
      discordServer.failNextChannelCreate(500, { message: 'server error' })
      const secondCsv = [HEADER, 'Ada,A,ada@a.edu,ada-a,gh-a'].join('\n')
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        secondCsv
      )

      expect(second.channelsFailed).toEqual([
        expect.objectContaining({ email: 'ada@a.edu', channelName: 'ada' }),
      ])
      // No orphan reported — nothing new was actually created for there to
      // be a stale channel to reconcile it against.
      expect(second.channelsOrphaned).toEqual([])
      // Only the one channel from the first import exists.
      const channels = discordServer.guildChannelsFor(seeded.guildId) as {
        name: string
        type: number
      }[]
      expect(
        channels
          .filter((c) => c.type === 0)
          .map((c) => c.name)
          .sort()
      ).toEqual(['ada-a-edu', 'ada-b-edu'])
    })
  })

  describe('rework finding 8 — handle resolution prefers an exact username match over a nickname', () => {
    it("resolves a row's handle to the member with a matching username, even when a different member's nickname also matches it", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        // A member whose own *username* is "bob" — this is who the roster
        // row below must resolve to.
        { user: { id: 'snowflake-real-bob', username: 'bob' } },
        // A different member who merely *nicknamed themselves* "bob".
        {
          user: { id: 'snowflake-nicknamed-bob', username: 'someone-else' },
          nick: 'bob',
        },
      ])

      const csv = [HEADER, 'Bob,B,bob@example.edu,bob,ghbob'].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      const created = discordServer.requests.find(
        (r) => r.method === 'POST'
      )?.body
      const overwrites = created?.['permission_overwrites'] as {
        id: string
        type: number
      }[]
      expect(
        overwrites.some((o) => o.type === 1 && o.id === 'snowflake-real-bob')
      ).toBe(true)
      expect(
        overwrites.some(
          (o) => o.type === 1 && o.id === 'snowflake-nicknamed-bob'
        )
      ).toBe(false)
      expect(report.unresolvedHandles).toEqual([])
      expect(report.ambiguousHandles).toEqual([])
    })

    it('reports an ambiguous handle — two members whose own nicknames both match — rather than guessing', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        {
          user: { id: 'snowflake-1', username: 'someone' },
          nick: 'bob',
        },
        {
          user: { id: 'snowflake-2', username: 'someone-else' },
          nick: 'bob',
        },
      ])

      const csv = [HEADER, 'Bob,B,bob@example.edu,bob,ghbob'].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.ambiguousHandles).toEqual([
        {
          line: 2,
          discord: 'bob',
          email: 'bob@example.edu',
          matchedDisplayNames: ['bob', 'bob'],
        },
      ])
      expect(report.unresolvedHandles).toEqual([])
      // Nobody is granted the individual member overwrite — an ambiguous
      // handle is treated the same as unresolved for the channel grant.
      const created = discordServer.requests.find(
        (r) => r.method === 'POST'
      )?.body
      const overwrites = created?.['permission_overwrites'] as {
        type: number
      }[]
      expect(overwrites.some((o) => o.type === 1)).toBe(false)
    })
  })

  // Cheap-fix 10: the private channel's own overwrites, asserted directly —
  // swapping `allowMemberOverwrite` for `allowRoleOverwrite` (or dropping it
  // entirely) must fail this test, not merely go unnoticed.
  it('grants exactly the resolved student their own member overwrite, alongside deny-everyone and allow-admins', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedCourseWithStudentCategory()
    discordServer.setGuildMembers(seeded.guildId, [
      { user: { id: 'snowflake-ada', username: 'adalovelace' } },
    ])
    const csv = [HEADER, 'Ada,Lovelace,ada@example.edu,adalovelace,adal'].join(
      '\n'
    )

    await runImport(seeded.organizationId, seeded.courseId, csv)

    const created = discordServer.requests.find(
      (r) => r.method === 'POST'
    )?.body
    const overwrites = created?.['permission_overwrites'] as {
      id: string
      type: number
      allow: string
      deny: string
    }[]
    // @everyone denied view.
    expect(
      overwrites.some((o) => o.id === seeded.guildId && o.type === 0)
    ).toBe(true)
    // The admins role allowed.
    expect(overwrites.some((o) => o.id === 'role-admins' && o.type === 0)).toBe(
      true
    )
    // The resolved student — a *member* overwrite (`type: 1`), not another
    // role grant — is the one this test would catch going missing.
    expect(
      overwrites.some((o) => o.id === 'snowflake-ada' && o.type === 1)
    ).toBe(true)
  })

  // Cheap-fix 11: every other idempotence fixture in this file uses an
  // already-lowercase, already-dash-free local part, so `normalizeChannelName`
  // is the identity function on it and a plain `===` would have passed this
  // test identically. This one uses a name Discord — and this handler's own
  // `channelNameForEmail` — actually rewrites (uppercase, an embedded
  // space), so the match on re-import is genuinely exercising slug-aware
  // comparison, not accidentally passing on already-equal strings.
  it('recognizes an already-created channel again on a re-import even though the email local part needed real slugging', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedCourseWithStudentCategory()
    discordServer.setGuildMembers(seeded.guildId, [
      { user: { id: 'snowflake-ada', username: 'adalovelace' } },
    ])
    const csv = [
      HEADER,
      'Ada,Lovelace,Ada Lovelace@example.edu,adalovelace,adal',
    ].join('\n')

    const first = await runImport(seeded.organizationId, seeded.courseId, csv)
    expect(first.channelsCreated).toEqual([
      expect.objectContaining({ channelName: 'ada-lovelace' }),
    ])

    const second = await runImport(seeded.organizationId, seeded.courseId, csv)
    expect(second.channelsCreated).toEqual([])
    expect(second.channelsAlreadyPresent).toEqual([
      expect.objectContaining({ channelName: 'ada-lovelace' }),
    ])
  })

  describe('cheap-fix 12 — channelsNotCreated, on both branches', () => {
    it('reports every row under channelsNotCreated when no student category has been scaffolded yet', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, []) // No categories declared at all.
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.channelsCreated).toEqual([])
      expect(report.channelsNotCreated).toEqual([
        {
          line: 2,
          email: 'ada@example.edu',
          reason: 'no student category has been scaffolded for this course yet',
        },
      ])
    })

    it('reports a row under channelsNotCreated when every student category is already full', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory([1])
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
        'Grace,Hopper,grace@example.edu,gracehopper,ghopper',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv,
        { categoryChannelCap: 1 }
      )

      expect(report.channelsCreated).toHaveLength(1)
      expect(report.channelsNotCreated).toEqual([
        {
          line: 3,
          email: 'grace@example.edu',
          reason: 'every student category is full',
        },
      ])
    })
  })

  describe('rework finding 13 — report gaps', () => {
    it('reports a field mergeRosterFields declined to change, so a corrected re-import is not read as unqualified success', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])

      // Ada's email was already proven wrong from another surface — a
      // roster's own corrected value must not silently fail to land.
      const existingPerson = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-ada' },
        testDb.db
      )
      people.overwriteRosterFields(
        seeded.organizationId,
        existingPerson.id,
        { email: 'ada-typo@example.edu' },
        testDb.db
      )

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.rosterFieldsDeclined).toEqual([
        {
          line: 2,
          discord: 'adalovelace',
          personId: existingPerson.id,
          fields: ['email'],
        },
      ])
    })

    it('always states the welcome-message limitation on the report, not only in docs', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER].join('\n')
      )

      expect(
        report.limitations.some((l) => l.toLowerCase().includes('welcome'))
      ).toBe(true)
    })
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

  // ENRL-3: a roster row is one of the three admission decisions — importing
  // it enrols the person it resolves to, recording `source: 'roster'`.
  describe('ENRL-3 — a roster row enrols the person it resolves to', () => {
    it('enrols a newly-created person, recording source "roster"', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      const personId = report.peopleCreated[0]?.personId
      expect(personId).toBeDefined()
      const enrolment = enrolments.getActiveEnrolment(
        seeded.organizationId,
        seeded.courseId,
        personId as string,
        testDb.db
      )
      expect(enrolment?.source).toBe('roster')
    })

    it('re-importing the same roster does not duplicate the enrolment', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const first = await runImport(seeded.organizationId, seeded.courseId, csv)
      const personId = first.peopleCreated[0]?.personId as string
      const before = enrolments.getActiveEnrolment(
        seeded.organizationId,
        seeded.courseId,
        personId,
        testDb.db
      )

      await runImport(seeded.organizationId, seeded.courseId, csv)

      const after = enrolments.getActiveEnrolment(
        seeded.organizationId,
        seeded.courseId,
        personId,
        testDb.db
      )
      expect(after?.id).toBe(before?.id)
    })

    // Cheap-fix 9: ROST-10's own synthetic `handle:`-keyed identity (this
    // file's own module comment) is a real person, created and merged onto
    // the same way a resolved one is — a row that never resolves in the
    // guild must still end up enrolled, not silently kept off the course.
    it('enrols the person created under a synthetic handle: identity when the Discord handle never resolves', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      // No guild members seeded at all — the row's handle cannot resolve.

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.unresolvedHandles).toHaveLength(1)
      const personId = report.peopleCreated[0]?.personId
      expect(personId).toBeDefined()
      const enrolment = enrolments.getActiveEnrolment(
        seeded.organizationId,
        seeded.courseId,
        personId as string,
        testDb.db
      )
      expect(enrolment?.source).toBe('roster')
    })

    // Rework finding 3: re-importing an unedited roster must not undo an
    // instructor's own `endEnrolment` call (ENRL-6). Fails without the fix:
    // before `enrolViaRoster` passed `reviveEnded: false` through to
    // `admit`, the second import below created a brand-new active row for
    // this person, silently reversing the removal.
    it('re-importing after an instructor ends the enrolment leaves it ended, not revived', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')
      const first = await runImport(seeded.organizationId, seeded.courseId, csv)
      const personId = first.peopleCreated[0]?.personId as string
      const originalEnrolment = enrolments.getActiveEnrolment(
        seeded.organizationId,
        seeded.courseId,
        personId,
        testDb.db
      )
      if (!originalEnrolment) throw new Error('setup failed: no enrolment')

      enrolments.endEnrolment(
        seeded.organizationId,
        originalEnrolment.id,
        testDb.db
      )

      await runImport(seeded.organizationId, seeded.courseId, csv)

      expect(
        enrolments.getActiveEnrolment(
          seeded.organizationId,
          seeded.courseId,
          personId,
          testDb.db
        )
      ).toBeUndefined()
      expect(
        enrolments.getEnrolment(
          seeded.organizationId,
          originalEnrolment.id,
          testDb.db
        )
      ).toMatchObject({
        id: originalEnrolment.id,
        endedAt: expect.any(Number),
      })
    })
  })
  // TEN-9 — the same defect `discord-scaffold.test.ts` covers for
  // scaffolding, one level over: an organization holding two active
  // bindings must not have every roster import refuse ("no active Discord
  // server bound," a message that lied when two were in fact bound) —
  // SRV-10: a course's admins role is created rather than left unresolved
  // when the guild lacks it, an existing role is used untouched, and a
  // permission failure creating one is reported without aborting the run —
  // the same three requirements `discord-scaffold.test.ts` proves for its
  // own two role names.
  describe('SRV-10 — the admins role is created when the guild lacks it', () => {
    it('creates the admins role with an empty permission bitfield, rather than reporting it unresolved', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      // Override the roles this file's own `seedCourseWithStudentCategory`
      // seeds — the guild has no role matching the course's admins role at
      // all this time.
      discordServer.setGuildRoles(seeded.guildId, [])
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.unresolvedRoles).toEqual([])
      expect(report.rolesCreated).toEqual([seeded.adminsRole])
      const roleCreate = discordServer.requests.find(
        (r) => r.method === 'POST' && r.path.endsWith('/roles')
      )
      expect(roleCreate).toBeDefined()
      expect(roleCreate?.body).toEqual({
        name: seeded.adminsRole,
        // Requirement 1: an empty permission bitfield — never
        // Administrator, Manage Channels, or anything else.
        permissions: '0',
      })
      // The newly created role — its real id, read from the fake's own
      // guild store rather than re-derived from the posted request body,
      // which never carries the id Discord assigns — still names the
      // channel's admin overwrite.
      const createdRole = discordServer
        .guildRolesFor(seeded.guildId)
        .find(
          (role) => (role as { name?: string }).name === seeded.adminsRole
        ) as { id?: string } | undefined
      const channelCreate = discordServer.requests.find(
        (r) => r.method === 'POST' && r.path.endsWith('/channels')
      )
      const overwrites = channelCreate?.body?.['permission_overwrites'] as {
        id: string
      }[]
      expect(overwrites.some((o) => o.id === createdRole?.id)).toBe(true)
    })

    it('uses an existing admins role untouched, making no create call for it', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.rolesCreated).toEqual([])
      expect(report.unresolvedRoles).toEqual([])
      expect(
        discordServer.requests.some(
          (r) => r.method === 'POST' && r.path.endsWith('/roles')
        )
      ).toBe(false)
    })

    it('reports a 403 creating a missing admins role as unresolved, without aborting the rest of the import', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildRoles(seeded.guildId, [])
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])
      discordServer.failNextRoleCreate(403, { message: 'Missing Permissions' })
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.rolesCreated).toEqual([])
      // Named with its own reason — `DiscordRequestError.message`, not a
      // bare status, so a bot missing Manage Roles reads differently from
      // a role sitting above the bot in the guild's own role order, even
      // though both are `403`s (`describeDiscordError`'s own SRV-10
      // rework, shared with `discord-scaffold.ts` via `@bloombot/discord-rest`).
      expect(report.unresolvedRoles).toEqual([
        { role: seeded.adminsRole, reason: expect.stringContaining('403') },
      ])
      expect(report.unresolvedRoles[0]?.reason).toContain('Manage Roles')
      // The rest of the run was not aborted — the student's channel was
      // still created.
      expect(report.channelsCreated).toHaveLength(1)
    })

    // A *transient* failure (a `429`, a `5xx`) creating the admins role
    // must not be swallowed the way a permanent one is — it has to throw
    // out of the handler, so JOB-2 retries rather than this run reporting
    // `succeeded` having silently created every student's channel missing
    // the admins grant. This test fails without the fix: before it, the
    // bare `catch` absorbed a 429 exactly like a 403 and the import
    // proceeded to create the channel anyway.
    it('rethrows a transient (429) failure creating the admins role, rather than absorbing it like a permanent one', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildRoles(seeded.guildId, [])
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])
      discordServer.failNextRoleCreate(429, {
        message: 'You are being rate limited',
      })
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      await expect(
        runImport(seeded.organizationId, seeded.courseId, csv)
      ).rejects.toMatchObject({ status: 429 })

      // Nothing was created at all — the run stopped at the failed role
      // creation rather than proceeding to create a mis-permissioned
      // channel.
      expect(
        discordServer.writeRequests().some((r) => r.path.endsWith('/channels'))
      ).toBe(false)
    })

    // A guild holding a role that differs from the course's declared
    // admins role only in case or surrounding whitespace must still be
    // recognised as the same one — the same case/whitespace-insensitive
    // match `resolveRoleId` has always given a category or channel name.
    // Before SRV-10 a regression here meant "reports one unresolved role";
    // after it, the same regression means "creates a duplicate role," a
    // materially worse failure this test now pins directly.
    it('matches an existing admins role that differs only in case or surrounding whitespace, creating nothing', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: `  ${seeded.adminsRole.toUpperCase()}  ` },
      ])
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])
      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,adalovelace,adal',
      ].join('\n')

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.rolesCreated).toEqual([])
      expect(report.unresolvedRoles).toEqual([])
      expect(
        discordServer.requests.some(
          (r) => r.method === 'POST' && r.path.endsWith('/roles')
        )
      ).toBe(false)
    })
  })

  // resolved through the course's own server instead.
  describe('an organization with more than one active binding (TEN-9)', () => {
    it("imports into the course's own server, never the organization's other active binding", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory([1])

      const secondInstaller = accounts.createAccount(
        seeded.organizationId,
        {
          email: `${randomUUID()}@example.edu`,
          displayName: 'Second Admin',
          role: 'owner',
        },
        testDb.db
      )
      const otherGuildId = randomUUID().replace(/-/g, '').slice(0, 18)
      discordServers.claimDiscordServerBinding(
        seeded.organizationId,
        { serverId: otherGuildId, installedByAccountId: secondInstaller.id },
        testDb.db
      )

      // The seeded course's own `discordServerId` was `null` — resolvable
      // while the organization held only one binding. Now that it holds
      // two, it must name which one explicitly.
      const course = courses.getCourse(
        seeded.organizationId,
        seeded.courseId,
        testDb.db
      )
      if (!course) throw new Error('setup failed: course not found')
      const updated = courses.updateCourse(
        seeded.organizationId,
        seeded.courseId,
        {
          projectId: course.projectId,
          title: course.title,
          enabled: course.enabled,
          adminsRole: course.adminsRole,
          studentsRole: course.studentsRole,
          discordServerId: seeded.guildId,
          categories: course.categories,
        },
        testDb.db
      )
      if (!updated?.ok) throw new Error('setup failed: unexpected conflict')

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,ada#1234,adalovelace',
      ].join('\n')
      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      expect(report.parseErrors).toEqual([])
      // The identity of the guild the import actually ran against — not
      // merely that it ran somewhere — and that every write landed there,
      // never `otherGuildId`.
      expect(report.guildId).toBe(seeded.guildId)
      expect(
        discordServer
          .writeRequests()
          .every((request) => !request.path.includes(otherGuildId))
      ).toBe(true)
    })

    it('refuses (rather than lying about "no active Discord server bound") when the course has no server of its own and the organization holds two active bindings', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory([1])

      const secondInstaller = accounts.createAccount(
        seeded.organizationId,
        {
          email: `${randomUUID()}@example.edu`,
          displayName: 'Second Admin',
          role: 'owner',
        },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        seeded.organizationId,
        {
          serverId: randomUUID().replace(/-/g, '').slice(0, 18),
          installedByAccountId: secondInstaller.id,
        },
        testDb.db
      )
      // TEN-9's own backfill (`repos/discord-servers.ts#claimDiscordServerBinding`,
      // D-77) resolves the course's own null column onto the organization's
      // *previous* sole binding the instant the claim above ran — correctly,
      // for a course that had one. This test wants the genuinely-undecided
      // state instead (a course with no single "previous" server to
      // attribute it to), so it clears the column back to null directly,
      // below the repo layer, the same device
      // `packages/db/tests/courses.test.ts`'s own unarchive-conflict test
      // uses for the identical reason.
      testDb.db.$client
        .prepare('UPDATE courses SET discord_server_id = NULL WHERE id = ?')
        .run(seeded.courseId)

      const csv = [
        HEADER,
        'Ada,Lovelace,ada@example.edu,ada#1234,adalovelace',
      ].join('\n')

      await expect(
        runImport(seeded.organizationId, seeded.courseId, csv)
      ).rejects.toThrow(/more than one active Discord server/)
    })
  })
})
