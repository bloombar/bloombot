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

import {
  accounts,
  courses,
  discordServers,
  jobs,
  organizations,
  projects,
} from '@bloombot/db'
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
import {
  FakeDiscordGuildServer,
  FAKE_BOT_USER_ID,
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
            accessRepaired: false,
          },
          {
            name: 'admins',
            status: 'created',
            adminsOnly: true,
            establishedByThisRun: true,
            accessRepaired: false,
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
            accessRepaired: false,
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
            accessRepaired: false,
          },
        ],
      },
    ])
  })

  // The bug this test exists for, observed in the field: a scaffold run
  // created its category and then failed `403` on every channel inside it,
  // four more times, with a message that named no cause.
  //
  // A course category denies `@everyone` view. Discord applies that denial to
  // the bot as well unless the bot is an Administrator, so the very next
  // call — creating a channel whose `parent_id` is that category — is refused
  // by the category the bot itself just made. The fix is an overwrite for the
  // bot's own user id, and this asserts it is actually sent, on both the
  // ordinary category and the admins-only channel.
  it('grants the bot itself access to the category it closes, so it can still create channels inside it', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      {
        name: 'Week 1',
        channels: [
          { name: 'general', adminsOnly: false },
          { name: 'staff', adminsOnly: true },
        ],
      },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])

    await runScaffold(seeded.organizationId, seeded.courseId)

    const writes = discordServer.writeRequests()
    const categoryCreate = writes.find(
      (request) => request.body?.['type'] === 4
    )
    const overwrites = (categoryCreate?.body?.['permission_overwrites'] ??
      []) as { id: string; type: number; allow: string }[]

    const botEntry = overwrites.find((entry) => entry.id === FAKE_BOT_USER_ID)
    expect(botEntry).toBeDefined()
    expect(botEntry?.type).toBe(1) // a member overwrite, not a role
    // View (0x400) and Manage Channels (0x10) are the two that decide whether
    // the next create succeeds; assert the bits rather than a magic string.
    const allowed = BigInt(botEntry?.allow ?? '0')
    expect(allowed & 0x400n).toBe(0x400n)
    expect(allowed & 0x10n).toBe(0x10n)

    // The admins-only channel closes itself the same way, so the same trap
    // exists there and is closed the same way.
    const adminsOnlyCreate = writes.find(
      (request) =>
        request.body?.['type'] === 0 &&
        Array.isArray(request.body?.['permission_overwrites'])
    )
    const adminsOnlyOverwrites = (adminsOnlyCreate?.body?.[
      'permission_overwrites'
    ] ?? []) as { id: string }[]
    expect(
      adminsOnlyOverwrites.some((entry) => entry.id === FAKE_BOT_USER_ID)
    ).toBe(true)
  })

  // The second half of the field failure. The first run created a category
  // with no overwrite for the bot, so every channel inside it was refused —
  // and every *later* run adopted that same category unchanged and failed
  // identically. A guild carrying a category from before the fix has to be
  // repaired on adoption, or scaffolding that course never works again.
  it('repairs its own access on a category created before the bot granted itself any', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])
    // Exactly what an earlier version of this handler left behind: the
    // category exists, `@everyone` is denied, and the bot is named nowhere.
    discordServer.setGuildChannels(seeded.guildId, [
      {
        id: 'cat-1',
        type: 4,
        name: 'Week 1',
        parent_id: null,
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
          { id: 'role-students', type: 0, allow: '3072', deny: '0' },
        ],
      },
    ])

    await runScaffold(seeded.organizationId, seeded.courseId)

    const repair = discordServer.requests
      .filter((request) => request.method === 'PUT')
      .find((request) =>
        request.path.endsWith(`/permissions/${FAKE_BOT_USER_ID}`)
      )
    expect(repair).toBeDefined()
    // It targets the adopted category, not some channel inside it.
    expect(repair?.path).toContain('/channels/cat-1/')
    const allowed = BigInt(String(repair?.body?.['allow'] ?? '0'))
    expect(allowed & 0x400n).toBe(0x400n) // view
    expect(allowed & 0x10n).toBe(0x10n) // manage channels
  })

  // SRV-9, the test that matters most: the user's actual situation. A
  // category that already exists without the bot in its overwrites,
  // holding a channel an instructor created by hand before the category
  // was repaired — Discord copied the category's overwrites in at that
  // channel's creation time, then stopped syncing them the moment the
  // channel got any of its own, so the channel kept its own stale snapshot
  // even after the category (in an earlier run) was fixed. One scaffold
  // run must repair both, leaving every other overwrite on each untouched.
  it('repairs its own access on both a category and a hand-made channel inside it that predate the bot granting itself any (D-51)', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])
    discordServer.setGuildChannels(seeded.guildId, [
      {
        id: 'cat-1',
        type: 4,
        name: 'Week 1',
        parent_id: null,
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
          { id: 'role-students', type: 0, allow: '3072', deny: '0' },
        ],
      },
      {
        // Made by hand before the category was repaired — its own
        // overwrites are a snapshot Discord stopped syncing with the
        // category's the moment it got any of its own, and the bot is
        // named nowhere in either.
        id: 'chan-1',
        type: 0,
        name: 'general',
        parent_id: 'cat-1',
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
          { id: 'role-students', type: 0, allow: '3072', deny: '0' },
        ],
      },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: {
        channels: {
          name: string
          status: string
          accessRepaired: boolean
        }[]
      }[]
    }

    const repairs = discordServer.requests.filter(
      (request) =>
        request.method === 'PUT' &&
        request.path.endsWith(`/permissions/${FAKE_BOT_USER_ID}`)
    )
    expect(repairs).toHaveLength(2)
    expect(repairs.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/channels/cat-1/'),
        expect.stringContaining('/channels/chan-1/'),
      ])
    )

    // Every other overwrite on both the category and the channel survived —
    // the students role grant and the `@everyone` denial that keeps the
    // course private, neither replaced nor dropped by the bot's own repair.
    const stored = discordServer.guildChannelsFor(seeded.guildId) as Record<
      string,
      unknown
    >[]
    const cat1 = stored.find((c) => c['id'] === 'cat-1') as Record<
      string,
      unknown
    >
    const chan1 = stored.find((c) => c['id'] === 'chan-1') as Record<
      string,
      unknown
    >
    for (const row of [cat1, chan1]) {
      const overwrites = row['permission_overwrites'] as { id: string }[]
      expect(overwrites.map((o) => o.id).sort()).toEqual(
        [seeded.guildId, 'role-students', FAKE_BOT_USER_ID].sort()
      )
    }

    expect(report.categories[0]?.channels[0]).toEqual(
      expect.objectContaining({
        name: 'general',
        status: 'already_present',
        accessRepaired: true,
      })
    )
  })

  // The other half of the same judgment call: a channel with none of its
  // own overwrites inherits its category's through Discord's own cascade
  // (including the bot's own repair, once the category has one) — writing
  // to it would be redundant, and would desync it from its category in
  // Discord's UI. Only the category gets a `PUT`.
  it('does not write to a channel with no overwrites of its own, once its category alone grants the bot access (D-51)', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])
    discordServer.setGuildChannels(seeded.guildId, [
      {
        id: 'cat-1',
        type: 4,
        name: 'Week 1',
        parent_id: null,
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
        ],
      },
      // No `permission_overwrites` of its own at all — inherits the
      // category's.
      { id: 'chan-1', type: 0, name: 'general', parent_id: 'cat-1' },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: { channels: { accessRepaired: boolean }[] }[]
    }

    const writes = discordServer.writeRequests()
    expect(writes).toHaveLength(1) // the category's own repair, nothing else
    expect(writes[0]?.path).toContain('/channels/cat-1/')
    expect(report.categories[0]?.channels[0]?.accessRepaired).toBe(false)
  })

  // SRV-9's admins-only case: a channel closed to everyone but admins,
  // created with its own overwrites before the bot granted itself
  // anything, must be repaired the same way — without widening who can see
  // it. The repair is one target's own entry; the students role must stay
  // absent, not get pulled in from anywhere.
  it('repairs an admins-only channel without widening who can see it (D-51)', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'staff', adminsOnly: true }] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])
    discordServer.setGuildChannels(seeded.guildId, [
      {
        id: 'cat-1',
        type: 4,
        name: 'Week 1',
        parent_id: null,
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
          { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
          { id: 'role-students', type: 0, allow: '3072', deny: '0' },
        ],
      },
      {
        // Admins-only by its own overwrite, deliberately excluding the
        // students role the category itself grants.
        id: 'chan-1',
        type: 0,
        name: 'staff',
        parent_id: 'cat-1',
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
          { id: 'role-admins', type: 0, allow: '3072', deny: '0' },
        ],
      },
    ])

    const report = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: {
        channels: { adminsOnly: boolean; accessRepaired: boolean }[]
      }[]
    }

    const stored = discordServer.guildChannelsFor(seeded.guildId) as Record<
      string,
      unknown
    >[]
    const chan1 = stored.find((c) => c['id'] === 'chan-1') as Record<
      string,
      unknown
    >
    const overwrites = chan1['permission_overwrites'] as { id: string }[]
    // The bot was added; the students role, deliberately absent before the
    // repair, is still absent after it.
    expect(overwrites.map((o) => o.id).sort()).toEqual(
      [seeded.guildId, 'role-admins', FAKE_BOT_USER_ID].sort()
    )
    expect(overwrites.some((o) => o.id === 'role-students')).toBe(false)
    expect(report.categories[0]?.channels[0]).toEqual(
      expect.objectContaining({ adminsOnly: true, accessRepaired: true })
    )
  })

  // SRV-7 applied to SRV-9's own repair: once a channel's access has been
  // fixed, a second run must find the bot already there and write nothing
  // — for the category and the channel alike.
  it('writes nothing on a second run once the category and channel access have both been repaired (D-51)', async () => {
    testDb = createTestDatabase()
    discordServer = await FakeDiscordGuildServer.start()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [
      { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
    ])
    discordServer.setGuildRoles(seeded.guildId, [
      { id: 'role-admins', name: seeded.adminsRole },
      { id: 'role-students', name: seeded.studentsRole },
    ])
    discordServer.setGuildChannels(seeded.guildId, [
      {
        id: 'cat-1',
        type: 4,
        name: 'Week 1',
        parent_id: null,
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
        ],
      },
      {
        id: 'chan-1',
        type: 0,
        name: 'general',
        parent_id: 'cat-1',
        permission_overwrites: [
          { id: seeded.guildId, type: 0, allow: '0', deny: '1024' },
        ],
      },
    ])

    await runScaffold(seeded.organizationId, seeded.courseId)
    const writesAfterFirstRun = discordServer.writeRequests().length
    expect(writesAfterFirstRun).toBe(2) // category repair + channel repair

    const secondReport = (await runScaffold(
      seeded.organizationId,
      seeded.courseId
    )) as {
      categories: { channels: { accessRepaired: boolean }[] }[]
    }

    // No new writes at all — the fake now shows the bot on both, so the
    // second run finds it already granted everywhere.
    expect(discordServer.writeRequests()).toHaveLength(writesAfterFirstRun)
    expect(secondReport.categories[0]?.channels[0]?.accessRepaired).toBe(false)
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

    // Nothing was *created* — both the category and its channel were
    // recognised as already present despite the case/whitespace mismatch.
    // The one write is the bot granting itself access to a category made
    // before it did that (a `PUT` on one overwrite, never a create), which is
    // what stops an adopted category refusing every channel inside it.
    expect(
      discordServer.writeRequests().filter((r) => r.method === 'POST')
    ).toHaveLength(0)
    expect(discordServer.writeRequests().map((r) => r.method)).toEqual(['PUT'])
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

    // Nothing was created — both were already present. The single `PUT` is
    // the bot's own access repair on the adopted category; it rewrites one
    // overwrite entry and leaves the observed permission state this test is
    // about untouched, which the report assertions below then prove.
    expect(
      discordServer.writeRequests().filter((r) => r.method === 'POST')
    ).toHaveLength(0)
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

  // TEN-9 — the decisive test: an organization with *two* active bindings, a
  // course assigned to one of them, scaffolding reaching that guild and not
  // the other. Before this slice, `getActiveDiscordServerBindingForOrganization`
  // refused a two-binding organization outright (its own `length === 1`
  // guard) — this is exactly the case that used to fail with "no active
  // Discord server bound" rather than reaching the right guild.
  describe('an organization with more than one active binding (TEN-9)', () => {
    it("scaffolds into the course's own server, never the organization's other active binding", async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [
        { name: 'Week 1', channels: [{ name: 'general', adminsOnly: false }] },
      ])

      // A second active binding for the same organization — a second
      // Discord server installed the bot too.
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
      // two, it must name which one explicitly, or scaffolding could not
      // proceed at all (the ambiguous case, covered separately below).
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
          filePrefix: course.filePrefix,
          enabled: course.enabled,
          adminsRole: course.adminsRole,
          studentsRole: course.studentsRole,
          discordServerId: seeded.guildId,
          categories: course.categories,
        },
        testDb.db
      )
      if (!updated?.ok) throw new Error('setup failed: unexpected conflict')

      discordServer.setGuildRoles(seeded.guildId, [
        { id: 'role-admins', name: seeded.adminsRole },
        { id: 'role-students', name: seeded.studentsRole },
      ])

      const report = (await runScaffold(
        seeded.organizationId,
        seeded.courseId
      )) as { categories: { name: string; status: string }[] }

      expect(report.categories).toEqual([
        expect.objectContaining({ name: 'Week 1', status: 'created' }),
      ])

      // The identity of the guild that received the writes, not merely
      // "a" guild: `seeded.guildId` got the category, `otherGuildId` was
      // never touched at all.
      expect(
        discordServer
          .guildChannelsFor(seeded.guildId)
          .some((c) => (c as Record<string, unknown>)['name'] === 'Week 1')
      ).toBe(true)
      expect(discordServer.guildChannelsFor(otherGuildId)).toEqual([])
      expect(
        discordServer
          .writeRequests()
          .every((request) => !request.path.includes(otherGuildId))
      ).toBe(true)
    })

    it('refuses (rather than guessing) when the course has no server of its own and the organization holds two active bindings', async () => {
      testDb = createTestDatabase()
      discordServer = await FakeDiscordGuildServer.start()
      const seeded = seedOrganizationWithBoundCourse(testDb.db, [
        { name: 'Week 1', channels: [] },
      ])
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

      // `seeded.courseId`'s own `discordServerId` is still `null`.
      await expect(
        runScaffold(seeded.organizationId, seeded.courseId)
      ).rejects.toThrow(/more than one active Discord server/)
    })
  })
})
