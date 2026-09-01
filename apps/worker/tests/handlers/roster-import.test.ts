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

import { enrolments, jobs, organizations, people } from '@bloombot/db'
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

  // Rework finding 6: two different rows' emails slug to the same channel
  // name — the second must be reported as a collision, not silently filed
  // as "already present" (which reads as "already set up").
  it('reports two different emails that slug to the same channel name as a collision, not a false already-present', async () => {
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

    const report = await runImport(seeded.organizationId, seeded.courseId, csv)

    expect(report.channelNameCollisions).toEqual([
      {
        line: 3,
        email: 'ada@gmail.com',
        channelName: 'ada',
        collidesWithLine: 2,
        collidesWithEmail: 'ada@school.edu',
      },
    ])
    // Only the first row's own channel was ever created — the second was
    // refused a channel entirely rather than sharing (or failing against)
    // the first's.
    expect(report.channelsCreated).toHaveLength(1)
    expect(report.channelsAlreadyPresent).toEqual([])
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
  })
})
