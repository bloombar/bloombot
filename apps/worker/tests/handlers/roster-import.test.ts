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
  rosterChannelAssignments,
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
import {
  FAKE_BOT_USER_ID,
  FakeDiscordGuildServer,
} from '../helpers/fake-discord-guild-server.js'
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
    // ROST-15: both left `undefined` by default, the same as a payload
    // predating this slice — `@bloombot/actions`' own `roster.import`
    // action is what defaults `createStudentCategories`, never this
    // handler (this file's own module comment), so a test that wants
    // "on" has to say so explicitly.
    createStudentCategories?: boolean
    studentCategoryBaseName?: string
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
    {
      courseId,
      csvText,
      ...(options?.createStudentCategories !== undefined
        ? { createStudentCategories: options.createStudentCategories }
        : {}),
      ...(options?.studentCategoryBaseName !== undefined
        ? { studentCategoryBaseName: options.studentCategoryBaseName }
        : {}),
    },
    {
      organizationId,
      jobId: randomUUID(),
      attempts: 1,
      db: testDb.db,
      logger: createFakeLogger(),
    }
  ) as Promise<RosterImportReport>
}

/** A CSV with `count` distinct, parseable rows — `student0@example.edu`, `student1@example.edu`, … — for a ROST-15 test that cares about the roster's own size, not any one row's content. */
function rosterCsv(count: number): string {
  const rows = Array.from(
    { length: count },
    (_, i) => `Student,${i},student${i}@example.edu,student${i}discord,`
  )
  return [HEADER, ...rows].join('\n')
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

  describe('ROST-17 — a student channel is remembered, not re-derived', () => {
    it("keeps a student's channel across an import whose corrected address would otherwise derive a different name", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ada', username: 'adalovelace' } },
      ])

      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Ada,Lovelace,ada@example.edu,adalovelace,adal'].join('\n')
      )
      expect(first.channelsCreated).toEqual([
        expect.objectContaining({ channelName: 'ada' }),
      ])
      const guildChannels = (guildId: string) =>
        discordServer.guildChannelsFor(guildId) as Record<string, unknown>[]
      const firstChannel = guildChannels(seeded.guildId).find(
        (c) => c['name'] === 'ada'
      )
      const person = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-ada' },
        testDb.db
      )

      // The roster is re-exported with Ada's address corrected — the same
      // person (same Discord handle), but `channelNameForEmail` now derives
      // a *different* name from this row than it did on the first import.
      // Before this record existed, the next import would look for a
      // channel named "ada-corrected", not find one, and create a second
      // channel for a student who already had one — this is exactly the
      // defect ROST-17 exists to close.
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [
          HEADER,
          'Ada,Lovelace,ada-corrected@example.edu,adalovelace,adal',
        ].join('\n')
      )

      expect(second.channelsCreated).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([
        expect.objectContaining({ line: 2 }),
      ])
      expect(
        guildChannels(seeded.guildId).filter((c) => c['type'] !== 4)
      ).toHaveLength(1) // no second channel was created
      const remembered = rosterChannelAssignments.getChannelAssignmentForPerson(
        seeded.organizationId,
        seeded.courseId,
        person.id,
        testDb.db
      )
      expect(remembered?.discordChannelId).toBe(firstChannel?.['id'])
    })

    // Review finding (must-fix 1): `mergePeople` did not repoint
    // `roster_channel_assignments` alongside identities/enrolments/
    // conversations, so a channel remembered under a synthetic,
    // handle-keyed person stayed attributed to the tombstoned loser the
    // instant that identity proved out and merged into a real person — the
    // next import, finding nothing remembered under the survivor, matched
    // the channel by name instead, read the dead loser as "somebody else"
    // (its identity had moved), and handed the survivor a second channel.
    it("keeps a student's remembered channel after her synthetic identity merges into her real one (person-link flow)", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      // Nobody resolves yet — Ada's handle is unresolved on this import, so
      // she is kept under a synthetic, handle-keyed identity.
      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Ada,Lovelace,ada@example.edu,adalovelace,adal'].join('\n')
      )
      expect(first.channelsCreated).toEqual([
        expect.objectContaining({ channelName: 'ada' }),
      ])
      const syntheticPerson = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'handle:adalovelace' },
        testDb.db
      )

      // Ada now proves her real Discord identity through the person-link
      // flow (`apps/api`'s `person-link.ts` calls `mergePeople` exactly
      // this way) — a *different* person is the survivor, the synthetic
      // one becomes the loser.
      const realPerson = people.createPerson(
        seeded.organizationId,
        {},
        testDb.db
      )
      const merge = people.mergePeople(
        seeded.organizationId,
        realPerson.id,
        syntheticPerson.id,
        testDb.db
      )
      expect(merge?.alreadyMerged).toBe(false)
      // The identity now resolves to the survivor — this is what makes
      // `handle:adalovelace` no longer point at the person the channel was
      // remembered for, unless the record moved with it.
      expect(
        people.resolveIdentity(
          seeded.organizationId,
          { surface: 'discord', externalId: 'handle:adalovelace' },
          testDb.db
        )?.id
      ).toBe(realPerson.id)

      // Her handle still has not resolved to any guild member — the next
      // import's row still constructs the identical `handle:adalovelace`
      // identity, which now resolves straight to the survivor.
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Ada,Lovelace,ada@example.edu,adalovelace,adal'].join('\n')
      )

      // No second channel — her one remembered channel, carried forward
      // onto the survivor by the merge itself, is found directly by the
      // survivor's own id and reported present, never re-created.
      expect(second.channelsCreated).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([
        expect.objectContaining({ line: 2 }),
      ])
      expect(second.channelOwnershipConflicts).toEqual([])
      expect(
        rosterChannelAssignments.getChannelAssignmentForPerson(
          seeded.organizationId,
          seeded.courseId,
          realPerson.id,
          testDb.db
        )?.discordChannelId
      ).toBeDefined()
      const channels = (
        discordServer.guildChannelsFor(seeded.guildId) as Record<
          string,
          unknown
        >[]
      ).filter((c) => c['type'] !== 4)
      expect(channels.map((c) => c['name'])).toEqual(['ada'])
    })

    it('recreates a remembered channel that has since been deleted from the server, rather than leaving the student with none', async () => {
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
      expect(first.channelsCreated).toHaveLength(1)
      const firstChannelId = first.channelsCreated[0]?.channelName

      // The channel is deleted from the server — the guild now holds only
      // the (still-scaffolded) empty category.
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
      ])

      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )

      // Recognized as gone and recreated — not reported as already present
      // (there is nothing there any more), and not left off the roster.
      expect(second.channelsCreated).toEqual([
        expect.objectContaining({ line: 2, channelName: firstChannelId }),
      ])
      expect(second.channelsAlreadyPresent).toEqual([])
      expect(second.channelsNotCreated).toEqual([])

      const person = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-ada' },
        testDb.db
      )
      const remembered = rosterChannelAssignments.getChannelAssignmentForPerson(
        seeded.organizationId,
        seeded.courseId,
        person.id,
        testDb.db
      )
      const newChannel = (
        discordServer.guildChannelsFor(seeded.guildId) as Record<
          string,
          unknown
        >[]
      ).find((c) => c['name'] === firstChannelId)
      expect(remembered?.discordChannelId).toBe(newChannel?.['id'])
    })

    it("never adopts a channel already remembered as another student's own channel", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ann-1', username: 'annfirst' } },
      ])

      // A first student is imported and given the channel "ann".
      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Ann,First,ann@example.edu,annfirst,gh-1'].join('\n')
      )
      expect(first.channelsCreated).toEqual([
        expect.objectContaining({ channelName: 'ann' }),
      ])

      // A second, genuinely different student joins a *later* roster —
      // a different address whose local part happens to slug to the same
      // name (`channelNameForEmail` only ever looks at the local part).
      // Nothing in this run's own roster collides (the first student is not
      // in this file at all), so only the remembered record stands between
      // this row and the first student's own private channel — exactly the
      // gap `channelBelongsToSomeoneElse`'s own doc comment names as
      // ROST-17's to close, since that guard alone cannot see across two
      // separate imports of two different rosters.
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-ann-2', username: 'annsecond' } },
      ])
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Ann,Second,ann@another.org,annsecond,gh-2'].join('\n')
      )

      // Never adopted, and never simply refused either — folded into the
      // same ROST-16 escalation a roster-internal collision already uses:
      // the second student gets her own, disambiguated channel instead.
      expect(second.channelsAlreadyPresent).toEqual([])
      expect(second.channelAccessGranted).toEqual([])
      expect(second.channelsNotCreated).toEqual([])
      expect(second.channelOwnershipConflicts).toEqual([
        expect.objectContaining({
          line: 2,
          email: 'ann@another.org',
          conflictingChannelName: 'ann',
        }),
      ])
      expect(second.channelsCreated).toEqual([
        expect.objectContaining({ line: 2, email: 'ann@another.org' }),
      ])
      expect(second.channelsCreated[0]?.channelName).not.toBe('ann')

      // The first student's channel still belongs to them alone.
      const firstPerson = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-ann-1' },
        testDb.db
      )
      const remembered = rosterChannelAssignments.getChannelAssignmentForPerson(
        seeded.organizationId,
        seeded.courseId,
        firstPerson.id,
        testDb.db
      )
      expect(remembered).toBeDefined()
    })

    // Review finding: an earlier draft of the "remembered elsewhere" carve
    // out compared stored *email strings*, which excuses far more than the
    // one identity-model gap it was meant for — any two genuinely
    // different people who ever carried the same address satisfied it.
    // Alice graduates; her address is reissued to Bob the next term; Bob's
    // own row has never had a channel. The bare string match must not let
    // Bob inherit Alice's channel (and, through it, her transcript).
    it("never hands a departed student's channel to a new student who is later issued the same address", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-alice', username: 'alice' } },
      ])

      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Alice,A,ada@example.edu,alice,gh-alice'].join('\n')
      )
      expect(first.channelsCreated).toEqual([
        expect.objectContaining({ channelName: 'ada' }),
      ])
      const alice = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-alice' },
        testDb.db
      )
      const aliceChannel =
        rosterChannelAssignments.getChannelAssignmentForPerson(
          seeded.organizationId,
          seeded.courseId,
          alice.id,
          testDb.db
        )
      expect(aliceChannel?.discordChannelId).toBeDefined()

      // Next term: Alice has graduated, and the identical address is
      // reissued to a genuinely different student, Bob — a different
      // Discord handle and a different resolved member entirely.
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-bob', username: 'bob' } },
      ])
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Bob,B,ada@example.edu,bob,gh-bob'].join('\n')
      )

      // Bob is never granted Alice's channel, silently or otherwise.
      expect(second.channelAccessGranted).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([])
      const aliceChannelStill =
        rosterChannelAssignments.getChannelAssignmentForPerson(
          seeded.organizationId,
          seeded.courseId,
          alice.id,
          testDb.db
        )
      // Alice's own record was never reassigned to Bob.
      expect(aliceChannelStill?.discordChannelId).toBe(
        aliceChannel?.discordChannelId
      )
      const aliceChannelOnGuild = (
        discordServer.guildChannelsFor(seeded.guildId) as Record<
          string,
          unknown
        >[]
      ).find((c) => c['id'] === aliceChannel?.discordChannelId) as
        { permission_overwrites: { id: string; type: number }[] } | undefined
      const individualGrants =
        aliceChannelOnGuild?.permission_overwrites.filter(
          (o) => o.type === 1
        ) ?? []
      // Bob's own snowflake was never granted view access to Alice's
      // channel.
      expect(individualGrants.map((o) => o.id)).not.toContain('snowflake-bob')
    })

    // Same hazard, the other way a stored string can coincide: two
    // genuinely different people whose stored emails differ only by case.
    it('never hands a channel to a different student whose stored email differs from the owner only by case', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-carol', username: 'carol' } },
      ])

      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Carol,C,Ada@school.edu,carol,gh-carol'].join('\n')
      )
      expect(first.channelsCreated).toEqual([
        expect.objectContaining({ channelName: 'ada' }),
      ])
      const carol = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-carol' },
        testDb.db
      )

      // A genuinely different student, Dana, is imported later with the
      // identical address spelled in a different case.
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-dana', username: 'dana' } },
      ])
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Dana,D,ada@school.edu,dana,gh-dana'].join('\n')
      )

      expect(second.channelAccessGranted).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([])
      const carolChannelStill =
        rosterChannelAssignments.getChannelAssignmentForPerson(
          seeded.organizationId,
          seeded.courseId,
          carol.id,
          testDb.db
        )
      expect(carolChannelStill?.discordChannelId).toBeDefined()
    })

    // Round 2 (D-88): the identity check alone still rests on one string —
    // the *handle*, not the email — and a synthetic `handle:<h>` person is
    // not provably this row's: two different real students can supply the
    // identical raw handle text across two different imports. Alice's
    // handle never resolves and she is remembered under `handle:ada`; the
    // next term, a genuinely different student, Bob, happens to own the
    // real Discord username `ada` *and* happens to share Alice's old
    // address's local part — the identity check alone would say "this is
    // Bob's own history." Requiring the stored address to agree too is
    // what refuses it.
    it('never hands a channel to a different student who happens to supply the same raw handle text a still-unresolved row was remembered under', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory()
      // Alice's own handle, "ada", never resolves to anyone this import.
      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Alice,A,alice@old.edu,ada,gh-alice'].join('\n')
      )
      expect(first.channelsCreated).toEqual([
        expect.objectContaining({ channelName: 'alice' }),
      ])
      const alice = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'handle:ada' },
        testDb.db
      )

      // Next term: Bob, a genuinely different student, really does own the
      // Discord username `ada` (it resolves this time), and his own
      // address happens to share Alice's old local part.
      discordServer.setGuildMembers(seeded.guildId, [
        { user: { id: 'snowflake-bob', username: 'ada' } },
      ])
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        [HEADER, 'Bob,B,alice@new.edu,ada,gh-bob'].join('\n')
      )

      // Bob is never granted Alice's channel — refused and given his own
      // instead, the same ROST-16 escalation a roster-internal collision
      // already uses.
      expect(second.channelAccessGranted).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([])
      expect(second.channelOwnershipConflicts).toEqual([
        expect.objectContaining({ line: 2, email: 'alice@new.edu' }),
      ])
      const aliceChannelStill =
        rosterChannelAssignments.getChannelAssignmentForPerson(
          seeded.organizationId,
          seeded.courseId,
          alice.id,
          testDb.db
        )
      expect(aliceChannelStill?.discordChannelId).toBeDefined()
      const aliceChannelOnGuild = (
        discordServer.guildChannelsFor(seeded.guildId) as Record<
          string,
          unknown
        >[]
      ).find((c) => c['id'] === aliceChannelStill?.discordChannelId) as
        { permission_overwrites: { id: string; type: number }[] } | undefined
      const individualGrants =
        aliceChannelOnGuild?.permission_overwrites.filter(
          (o) => o.type === 1
        ) ?? []
      expect(individualGrants.map((o) => o.id)).not.toContain('snowflake-bob')
    })

    it("adopts a course's pre-existing channel once, and does not duplicate it on a later import", async () => {
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
      expect(first.channelsCreated).toHaveLength(1)

      // Simulate a channel that predates ROST-17's own record — an earlier
      // version of this course's own import created it, and nothing ever
      // recorded who it belongs to.
      const person = people.resolvePersonByIdentity(
        seeded.organizationId,
        { surface: 'discord', externalId: 'snowflake-ada' },
        testDb.db
      )
      testDb.db.$client
        .prepare(
          'DELETE FROM roster_channel_assignments WHERE course_id = ? AND person_id = ?'
        )
        .run(seeded.courseId, person.id)
      expect(
        rosterChannelAssignments.getChannelAssignmentForPerson(
          seeded.organizationId,
          seeded.courseId,
          person.id,
          testDb.db
        )
      ).toBeUndefined()

      // The next import matches it by name, adopts it (remembers it), and
      // reports it as already present rather than creating a duplicate.
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        csv
      )
      expect(second.channelsCreated).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([
        expect.objectContaining({ line: 2 }),
      ])
      expect(
        rosterChannelAssignments.getChannelAssignmentForPerson(
          seeded.organizationId,
          seeded.courseId,
          person.id,
          testDb.db
        )
      ).toBeDefined()

      // A third import still finds exactly one channel — adoption did not
      // duplicate it, and the remembered record now serves every later run.
      const third = await runImport(seeded.organizationId, seeded.courseId, csv)
      expect(third.channelsCreated).toEqual([])
      expect(
        (
          discordServer.guildChannelsFor(seeded.guildId) as Record<
            string,
            unknown
          >[]
        ).filter((c) => c['type'] !== 4)
      ).toHaveLength(1)
    })
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

    // ROST-17 closes this the way `ChannelOrphanedEntry`'s own doc comment
    // (above) always said it eventually would: Ada A's channel is now
    // remembered by *her*, not re-derived from whatever name her address
    // currently slugs to — so freeing the bare `ada` name by removing the
    // colliding row no longer moves her to a second channel at all. She
    // keeps the one she already has, under its own real name, and no
    // orphan is created because nothing new is.
    it('keeps the remembered channel when removing a colliding row frees the bare name, rather than moving the student to a fresh one', async () => {
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

      // The second import's roster no longer includes `ada@b.edu` — before
      // ROST-17, `ada@a.edu` would have been entitled to the bare name
      // again and moved there, orphaning her first channel.
      const secondCsv = [HEADER, 'Ada,A,ada@a.edu,ada-a,gh-a'].join('\n')
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        secondCsv
      )

      // Found by her own remembered record, under the name she already
      // has — never re-derived, never moved, and nothing new created.
      expect(namesByEmail(second)['ada@a.edu']).toBe('ada-a-edu')
      expect(second.channelsCreated).toEqual([])
      expect(second.channelsOrphaned).toEqual([])
      // Both original channels still exist, untouched — `ada-b-edu`
      // (Ada B's own, never touched by the second import at all) and Ada
      // A's, and no bare `ada` channel was ever created.
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

    // The same closing applies to round 3's own must-fix scenario: since
    // Ada A's remembered channel is found directly, this run never
    // attempts to create anything for her at all — there is no create left
    // to fail, and so nothing for `channelsFailed`/`channelsOrphaned` to
    // disagree about.
    it('does not attempt to create (or fail creating) a channel for a student whose own channel is already remembered', async () => {
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

      // The second import's roster is down to just `ada@a.edu` again —
      // before ROST-17 this would have been entitled to (and attempted) the
      // bare `ada`, made to fail here; her remembered channel means this
      // run never calls `createGuildChannel` for her row at all.
      discordServer.failNextChannelCreate(500, { message: 'server error' })
      const secondCsv = [HEADER, 'Ada,A,ada@a.edu,ada-a,gh-a'].join('\n')
      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        secondCsv
      )

      expect(second.channelsFailed).toEqual([])
      expect(second.channelsAlreadyPresent).toEqual([
        expect.objectContaining({
          email: 'ada@a.edu',
          channelName: 'ada-a-edu',
        }),
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

  describe('ROST-15 — an import creates the student categories it needs', () => {
    it('creates the categories a large roster needs when none are scaffolded yet, and places every student', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, []) // Nothing scaffolded at all.

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(120),
        { createStudentCategories: true }
      )

      // 120 students at Discord's real 50-per-category cap needs three —
      // the default `categoryChannelCap` this handler otherwise uses.
      expect(report.categoriesCreated).toEqual([
        'Test Course - STUDENTS 01',
        'Test Course - STUDENTS 02',
        'Test Course - STUDENTS 03',
      ])
      expect(report.categoriesFailed).toEqual([])
      expect(report.channelsCreated).toHaveLength(120)
      expect(report.channelsNotCreated).toEqual([])

      // Requirement 4's other half — a created category's own permissions:
      // denies `@everyone`, grants the bot itself (without which every
      // `createGuildChannel` call just made inside it would have 403'd),
      // and grants the course's admins role (SRV-10 created it, since this
      // guild had no roles at all).
      const adminsRoleId = discordServer
        .guildRolesFor(seeded.guildId)
        .find(
          (role) => (role as { name?: string }).name === seeded.adminsRole
        ) as { id?: string } | undefined
      const categoryCreates = discordServer.requests.filter(
        (r) =>
          r.method === 'POST' &&
          r.path.endsWith('/channels') &&
          r.body?.['type'] === 4
      )
      expect(categoryCreates).toHaveLength(3)
      for (const request of categoryCreates) {
        const overwrites = request.body?.['permission_overwrites'] as {
          id: string
        }[]
        expect(overwrites.some((o) => o.id === seeded.guildId)).toBe(true) // @everyone deny
        expect(overwrites.some((o) => o.id === FAKE_BOT_USER_ID)).toBe(true)
        expect(overwrites.some((o) => o.id === adminsRoleId?.id)).toBe(true)
      }
    })

    it('creates nothing when an already-scaffolded course already has room for the roster', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory([1, 2, 3]) // 150 seats — plenty for 120.
      discordServer.setGuildMembers(seeded.guildId, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(120),
        { createStudentCategories: true }
      )

      expect(report.categoriesCreated).toEqual([])
      expect(report.categoriesFailed).toEqual([])
      expect(report.channelsNotCreated).toEqual([])
      // No category-management call of any kind — not even the one this
      // handler would need before it could create or repair a category
      // (`getBotUserId`) — proving this run touched nothing beyond placing
      // students into the room that already existed.
      expect(discordServer.requests.some((r) => r.path === '/users/@me')).toBe(
        false
      )
      expect(
        discordServer.requests.some(
          (r) =>
            r.method === 'POST' &&
            r.path.endsWith('/channels') &&
            r.body?.['type'] === 4
        )
      ).toBe(false)
    })

    // Round 3's blocker: sizing counted students who already held a
    // channel in the numerator while also subtracting the seat each of
    // them occupies, so a steady-state re-import asked for categories it
    // did not need and created them empty. SRV-8 never deletes, so the
    // junk was permanent. Asserts the guild, not the report: the second
    // run must add no category of its own.
    it('creates no category on a re-import that places nobody new, even when the existing ones are full', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      // Exactly 4 seats at cap 2, and a roster of exactly 4 — the first
      // run fills them completely, so every seat is occupied on the second.
      const seeded = seedCourseWithStudentCategory([1, 2])
      discordServer.setGuildMembers(seeded.guildId, [])

      const first = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(4),
        { createStudentCategories: true, categoryChannelCap: 2 }
      )
      expect(first.categoriesCreated).toEqual([])
      expect(first.channelsCreated).toHaveLength(4)

      const categoriesAfterFirst = discordServer.requests.filter(
        (r) =>
          r.method === 'POST' &&
          r.path.endsWith('/channels') &&
          r.body?.['type'] === 4
      ).length

      const second = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(4),
        { createStudentCategories: true, categoryChannelCap: 2 }
      )

      expect(second.categoriesCreated).toEqual([])
      expect(second.channelsCreated).toEqual([])
      expect(second.channelsAlreadyPresent).toHaveLength(4)
      expect(second.channelsNotCreated).toEqual([])
      // The wire is the real assertion: no second-run category POST at all.
      const categoriesAfterSecond = discordServer.requests.filter(
        (r) =>
          r.method === 'POST' &&
          r.path.endsWith('/channels') &&
          r.body?.['type'] === 4
      ).length
      expect(categoriesAfterSecond).toBe(categoriesAfterFirst)
    })

    it('continues numbering past the categories that already exist, rather than restarting', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedCourseWithStudentCategory([1, 2]) // 4 seats at cap 2.
      discordServer.setGuildMembers(seeded.guildId, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(5), // Needs 3 categories at cap 2 — one more than exists.
        { createStudentCategories: true, categoryChannelCap: 2 }
      )

      expect(report.categoriesCreated).toEqual(['Test Course - STUDENTS 03'])
      expect(report.channelsNotCreated).toEqual([])
    })

    it('reuses an already-existing category under the target name rather than duplicating it, repairing the bot access it was missing', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      // One category the course itself declares, plus one that is not
      // declared anywhere in `course.categories` at all — the shape a
      // category an earlier ROST-15 run created, or an instructor made by
      // hand, actually has. Missing the bot's own overwrite, the way a
      // category created before this run existed would be.
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [
        { name: 'Test Course - STUDENTS 01', channels: [] },
      ])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        {
          id: 'cat-2',
          type: 4,
          name: 'Test Course - STUDENTS 02',
          parent_id: null,
          permission_overwrites: [], // no bot access yet
        },
      ])
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
        { id: 'role-students', name: seeded.studentsRole },
      ])
      discordServer.setGuildMembers(seeded.guildId, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(4), // Needs 2 categories at cap 2 — exactly what already exists.
        { createStudentCategories: true, categoryChannelCap: 2 }
      )

      expect(report.categoriesCreated).toEqual([]) // reused, not duplicated
      expect(
        discordServer.requests.some(
          (r) =>
            r.method === 'POST' &&
            r.path.endsWith('/channels') &&
            r.body?.['type'] === 4
        )
      ).toBe(false)
      expect(report.channelsCreated).toHaveLength(4)

      // The undeclared category's own bot access was repaired.
      const repaired = discordServer
        .guildChannelsFor(seeded.guildId)
        .find((channel) => (channel as { id?: string }).id === 'cat-2') as
        { permission_overwrites?: { id: string }[] } | undefined
      expect(
        repaired?.permission_overwrites?.some((o) => o.id === FAKE_BOT_USER_ID)
      ).toBe(true)
    })

    it("the checkbox off reproduces exactly today's reporting — nothing created", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(1),
        { createStudentCategories: false }
      )

      expect(report.categoriesCreated).toEqual([])
      expect(report.categoriesFailed).toEqual([])
      expect(report.channelsCreated).toEqual([])
      expect(report.channelsNotCreated).toEqual([
        {
          line: 2,
          email: 'student0@example.edu',
          reason: 'no student category has been scaffolded for this course yet',
        },
      ])
      expect(discordServer.requests.some((r) => r.path === '/users/@me')).toBe(
        false
      )
    })

    // Requirement 6, the "rethrow" half — the SRV-10 admins-role test above
    // proves the same contract for a role create; this is the identical
    // proof for a category create. This test fails without the fix: before
    // it, nothing distinguished a transient failure creating a category
    // from a permanent one, so a rate limit would have been absorbed and
    // reported under `categoriesFailed` instead of retried.
    it('rethrows a transient (429) failure creating a category, rather than absorbing it', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
      discordServer.failNextChannelCreate(429, {
        message: 'You are being rate limited',
      })

      await expect(
        runImport(seeded.organizationId, seeded.courseId, rosterCsv(1), {
          createStudentCategories: true,
        })
      ).rejects.toMatchObject({ status: 429 })

      // The category create was attempted (and rejected) — this fake only
      // appends to its own guild store on a 2xx, so nothing landed despite
      // the request having been made.
      expect(discordServer.guildChannelsFor(seeded.guildId)).toEqual([])
    })

    // Requirement 6, the "absorb" half — a permanent refusal (403) creating
    // a category is reported under `categoriesFailed`, and the rest of the
    // import still runs (the row that would have landed there is reported
    // under `channelsNotCreated`, the same as any other full-up run).
    it('reports a 403 creating a category under categoriesFailed, without aborting the rest of the import', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
      discordServer.failNextChannelCreate(403, {
        message: 'Missing Permissions',
      })

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(1),
        { createStudentCategories: true }
      )

      expect(report.categoriesCreated).toEqual([])
      expect(report.categoriesFailed).toEqual([
        {
          name: 'Test Course - STUDENTS 01',
          reason: expect.stringContaining('403'),
        },
      ])
      expect(report.channelsNotCreated).toEqual([
        {
          line: 2,
          email: 'student0@example.edu',
          reason: 'no student category has been scaffolded for this course yet',
        },
      ])
    })

    // Blocker 1 (review round 2): sizing used to compare the roster against
    // a bare category *count*, not the free seats actually left — so an
    // already-full category (SRV-8 never deletes a term's worth of alumni
    // channels) was counted as room that plainly was not there, and the
    // box being ticked created nothing at all while stranding every new
    // student. This is the ordinary second-term case the feature exists
    // for. Fails without the fix: `categoriesCreated` comes back `[]` and
    // both new rows land in `channelsNotCreated`.
    it('sizes against free seats, not a bare category count — a full category still gets a fresh one created alongside it', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [
        { name: 'Test Course - STUDENTS 01', channels: [] },
      ])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        // Two channels already occupy this category's only two seats —
        // last term's alumni, never deleted (SRV-8).
        { id: 'chan-alum-1', type: 0, name: 'alum1', parent_id: 'cat-1' },
        { id: 'chan-alum-2', type: 0, name: 'alum2', parent_id: 'cat-1' },
      ])
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
        { id: 'role-students', name: seeded.studentsRole },
      ])
      discordServer.setGuildMembers(seeded.guildId, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(2),
        { createStudentCategories: true, categoryChannelCap: 2 }
      )

      expect(report.categoriesCreated).toEqual(['Test Course - STUDENTS 02'])
      expect(report.channelsCreated).toHaveLength(2)
      expect(report.channelsNotCreated).toEqual([])
    })

    // The partial-occupancy half of the same fix — one free seat left, two
    // new students: the new category only needs to cover the shortfall
    // (one seat), not the whole roster.
    it('creates only the shortfall against a partially-occupied category, not a fresh category per student', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [
        { name: 'Test Course - STUDENTS 01', channels: [] },
      ])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
        },
        { id: 'chan-alum-1', type: 0, name: 'alum1', parent_id: 'cat-1' },
      ])
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
        { id: 'role-students', name: seeded.studentsRole },
      ])
      discordServer.setGuildMembers(seeded.guildId, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(2),
        { createStudentCategories: true, categoryChannelCap: 2 }
      )

      // One free seat already existed; only one more category (2 more
      // seats) is needed to cover the second new student.
      expect(report.categoriesCreated).toEqual(['Test Course - STUDENTS 02'])
      expect(report.channelsCreated).toHaveLength(2)
      expect(report.channelsNotCreated).toEqual([])
    })

    // Should-fix (review round 2): `categoryNumberForBaseName` used to
    // compare by `normalizeName` alone (case/whitespace only) — an
    // instructor's own double space (`Test Course  -  STUDENTS 01`) was
    // not recognised as the same category the base name describes, so this
    // run tried to create a second, functionally identical one. Fails
    // without the fix: `categoriesCreated` names a duplicate `... 01`.
    it('recognises an existing category whose separators differ from the base name, rather than duplicating it', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          // Hyphens where the base name has spaces, and an unpadded
          // single-digit number. Deliberately *not* the double-space
          // variant: that one is caught by the create loop's own
          // duplicate guard even with case-only matching, so it passes
          // whether or not `categoryNumberForBaseName` is
          // separator-tolerant, and pins nothing. This spelling is only
          // recognised by the tolerant comparison itself.
          name: 'Test Course-STUDENTS-1',
          parent_id: null,
        },
      ])
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
      ])
      discordServer.setGuildMembers(seeded.guildId, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(1),
        { createStudentCategories: true, categoryChannelCap: 2 }
      )

      expect(report.categoriesCreated).toEqual([])
      expect(
        discordServer.requests.some(
          (r) =>
            r.method === 'POST' &&
            r.path.endsWith('/channels') &&
            r.body?.['type'] === 4
        )
      ).toBe(false)
      expect(report.channelsCreated).toHaveLength(1)
    })

    // Blocker 2 (review round 2): an adopted category's own permissions
    // were never checked against what the course asks for — only its bot
    // access. Fails without the fix: no `PUT` for `@everyone`/the admins
    // role is ever sent, and the category stays exactly as a person set it
    // by hand.
    it('repairs an adopted category that explicitly allows @everyone and grants no admins role, and reports nothing wrong once it does', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
          permission_overwrites: [
            // Explicitly *allows* @everyone — the opposite of what the
            // course asks for.
            { id: seeded.guildId, type: 0, allow: '1024', deny: '0' },
            // Bot access already present, so that repair is skipped.
            { id: FAKE_BOT_USER_ID, type: 1, allow: '3088', deny: '0' },
          ],
        },
      ])
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
      ])
      discordServer.setGuildMembers(seeded.guildId, [])

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(2),
        { createStudentCategories: true, categoryChannelCap: 50 }
      )

      expect(report.categoriesPermissionsNotRepaired).toEqual([])
      expect(report.channelsCreated).toHaveLength(2)

      const adminsRoleId = discordServer
        .guildRolesFor(seeded.guildId)
        .find(
          (role) => (role as { name?: string }).name === seeded.adminsRole
        ) as { id?: string } | undefined
      const puts = discordServer.requests.filter(
        (r) =>
          r.method === 'PUT' &&
          r.path.startsWith('/channels/cat-1/permissions/')
      )
      expect(
        puts.some((r) => r.path.endsWith(`/permissions/${seeded.guildId}`))
      ).toBe(true)
      expect(
        puts.some((r) => r.path.endsWith(`/permissions/${adminsRoleId?.id}`))
      ).toBe(true)

      const repaired = discordServer
        .guildChannelsFor(seeded.guildId)
        .find((channel) => (channel as { id?: string }).id === 'cat-1') as
        | {
            permission_overwrites?: {
              id: string
              allow: string
              deny: string
            }[]
          }
        | undefined
      const everyoneEntry = repaired?.permission_overwrites?.find(
        (overwrite) => overwrite.id === seeded.guildId
      )
      expect(everyoneEntry?.deny).toBe('1024')
    })

    // The failure half of the same fix — a category-level permission
    // repair that Discord permanently refuses is named on the report
    // rather than silently accepted, and the category is still used for
    // placement (every child channel carries its own explicit overwrite —
    // ROST-16 — so this is a category-level honesty gap, not a leak).
    it('names a category whose @everyone/admins repair permanently fails, without excluding it from placement', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
          permission_overwrites: [
            { id: seeded.guildId, type: 0, allow: '1024', deny: '0' },
            { id: FAKE_BOT_USER_ID, type: 1, allow: '3088', deny: '0' },
          ],
        },
      ])
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
      ])
      discordServer.setGuildMembers(seeded.guildId, [])
      discordServer.failNextPermissionPut(403, {
        message: 'Missing Permissions',
      })

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(1),
        { createStudentCategories: true, categoryChannelCap: 50 }
      )

      expect(report.categoriesPermissionsNotRepaired).toEqual([
        {
          name: 'Test Course - STUDENTS 01',
          reason: expect.stringContaining('403'),
        },
      ])
      // Still used — the row still got its own channel, in this category.
      expect(report.channelsCreated).toHaveLength(1)
      expect(report.categoriesFailed).toEqual([])
    })

    // Blocker 2's other half — a category whose *bot-access* repair is
    // permanently refused cannot be written into at all this run, and must
    // not be silently offered as capacity (the placement loop would only
    // 403 the moment it reached it, and a category with room never even
    // gets that far, so nothing would ever report it). Fails without the
    // fix: `categoriesFailed` is `[]`, `categoriesCreated` is `[]`, and the
    // one row silently lands in `channelsNotCreated`.
    it('excludes an adopted category from placement, and reports why, when its bot-access repair is permanently refused', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
      discordServer.setGuildChannels(seeded.guildId, [
        {
          id: 'cat-1',
          type: 4,
          name: 'Test Course - STUDENTS 01',
          parent_id: null,
          permission_overwrites: [], // no bot access
        },
      ])
      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
      ])
      discordServer.setGuildMembers(seeded.guildId, [])
      discordServer.failNextPermissionPut(403, {
        message: 'Missing Permissions',
      })

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(1),
        { createStudentCategories: true, categoryChannelCap: 2 }
      )

      expect(report.categoriesFailed).toEqual([
        {
          name: 'Test Course - STUDENTS 01',
          reason: expect.stringContaining('403'),
        },
      ])
      // Rerouted to a fresh category instead — numbered 02, continuing
      // past the excluded 01 (requirement 2's own "never reuse a number").
      expect(report.categoriesCreated).toEqual(['Test Course - STUDENTS 02'])
      expect(report.channelsCreated).toHaveLength(1)
    })

    // The two-smaller-ones fix (review round 2): a permanent failure
    // creating a category used to stop the loop silently — the report
    // named only the first slot that failed, leaving any further
    // still-needed category unmentioned even though the same permanent
    // refusal would identically block it too. Fails without the fix:
    // `categoriesFailed` has length 1, not 3.
    it('names every still-needed category as failed, not only the first, once a permanent refusal stops further attempts', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
      discordServer.failNextChannelCreate(403, {
        message: 'Missing Permissions',
      })

      const report = await runImport(
        seeded.organizationId,
        seeded.courseId,
        rosterCsv(3),
        { createStudentCategories: true, categoryChannelCap: 1 }
      )

      expect(report.categoriesCreated).toEqual([])
      expect(report.categoriesFailed).toEqual([
        {
          name: 'Test Course - STUDENTS 01',
          reason: expect.stringContaining('403'),
        },
        {
          name: 'Test Course - STUDENTS 02',
          reason: expect.stringContaining('403'),
        },
        {
          name: 'Test Course - STUDENTS 03',
          reason: expect.stringContaining('403'),
        },
      ])
      expect(report.channelsNotCreated).toHaveLength(3)
    })
  })
})
