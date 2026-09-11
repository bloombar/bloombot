/**
 * `runCatchUp`/`wireCatchUp` (`catch-up.ts`) — the discord.js half of SURF-9.
 * Exercised against a real throwaway database, a fake model client, and
 * plain discord.js fakes (`helpers/fake-discord.ts`) — no real gateway
 * connection. Each test below fails without the rework finding it names;
 * see the report for how each was confirmed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { discordGatewayStatus, discordHandledMessages } from '@bloombot/db'
import { createAdmissionGate } from '@bloombot/jobs'
import { Events } from 'discord.js'

import { runCatchUp, wireCatchUp } from '../src/catch-up.js'
import { createInFlightMessageIds } from '../src/in-flight-messages.js'
import {
  fakeChannel,
  fakeGuild,
  fakeGuildMember,
  fakeMessage,
  fakeReadyClient,
} from './helpers/fake-discord.js'
import { createFakeLogger, type FakeLogger } from './helpers/fake-logger.js'
import { FakeModelClient } from './helpers/fake-model-client.js'
import { seedBoundServerWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

const PRICING = {
  rates: {},
  defaultRate: {
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
  },
}

/** `runCatchUp`'s own dependencies, minus `bounds`, which each test supplies. */
function baseDeps(
  testDatabase: TestDatabase,
  model: FakeModelClient,
  logger: FakeLogger
) {
  return {
    botId: 'bot-1',
    botDisplayName: 'Bloombot',
    db: testDatabase.db,
    model,
    logger,
    admission: createAdmissionGate({ limit: 5, waitMs: 1000 }),
    pricing: PRICING,
    connectUrl: 'https://app.bloombot.test',
    inFlight: createInFlightMessageIds(),
  }
}

/**
 * SURF-9 rework round 2, MF-B — establishes a non-empty
 * `discord_gateway_status` marker at `lastKnownConnectedAt`, the window
 * floor `runCatchUp` reads (replacing round 1's `discord_handled_messages`-
 * derived floor).
 */
function seedConnectedMarker(
  testDatabase: TestDatabase,
  lastKnownConnectedAt: number
) {
  discordGatewayStatus.recordLastKnownConnected(
    lastKnownConnectedAt,
    testDatabase.db
  )
}

describe('runCatchUp (SURF-9)', () => {
  // MF-B — an empty marker means no known baseline; this run must not guess
  // the full lookback.
  it('cold start (no discord_gateway_status marker) skips the scan entirely — no channel is ever fetched', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const message = fakeMessage({ guildId, categoryName: 'Week 1' })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(channel.messages.fetch).not.toHaveBeenCalled()
    expect(model.calls).toHaveLength(0)
  })

  // MF1 — the newest page, not the oldest since the cutoff: `fetch` must be
  // called with `limit` only, never an `after` cursor.
  it('fetches the newest page of a channel — limit only, no after cursor', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)
    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 100 })
  })

  // MF-B — the window's own floor is the last-known-connected marker,
  // capped by the lookback: a candidate older than that floor is never even
  // considered, even though it is well within the configured lookback on
  // its own.
  it('excludes a candidate older than the last-known-connected floor, even though it is within the configured lookback', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000) // floor = now - 200_000

    const tooOld = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> old question',
      createdTimestamp: now - 300_000, // older than the floor
    })
    const withinWindow = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> new question',
      createdTimestamp: now - 100_000, // within the floor..sessionStart window
    })
    const channel = fakeChannel({
      id: 'chan-1',
      messages: [tooOld, withinWindow],
    })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(model.calls).toHaveLength(1)
    expect(tooOld.reply).not.toHaveBeenCalled()
    expect(withinWindow.reply).toHaveBeenCalled()
  })

  // MF-B — restarting a process that has been connected for a long time on
  // a *quiet* server (never mind the message traffic) must still scan on
  // the next restart: the marker is unaffected by
  // `discord_handled_messages`'s own pruning, so a floor that predates the
  // configured lookback is simply capped at the lookback, never treated as
  // "nothing to catch up on".
  it('caps the floor at the lookback ceiling when the marker itself is older than the lookback', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 10 * 24 * 60 * 60 * 1000) // 10 days ago — well before the 24h lookback

    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    // The scan still ran (the marker being old does not itself mean "skip
    // entirely" — only an *absent* marker does) and answered a message well
    // within the 24h lookback.
    expect(model.calls).toHaveLength(1)
  })

  // MF-C — a message created at or after this scan's own start is a
  // candidate the live path already owns; including it here too would
  // answer it twice.
  it('excludes a candidate created at or after this scan itself began (sessionStart)', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    // "Delivered live during the scan": created after the scan's own
    // `sessionStart` is captured, simulated here with a timestamp far
    // enough in the future that it is unambiguously "at or after now"
    // however many milliseconds elapse before `runCatchUp` actually reads
    // `Date.now()`.
    const liveMessage = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> live question',
      createdTimestamp: now + 60_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [liveMessage] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(model.calls).toHaveLength(0)
    expect(liveMessage.reply).not.toHaveBeenCalled()
    expect(
      discordHandledMessages.isMessageHandled(liveMessage.id, testDb.db)
    ).toBe(false)
  })

  // MF3 — the `handledIds` snapshot, taken once before any channel is
  // fetched, is stale by the time a decision is dispatched if the live path
  // answers the same message in the meantime; a fresh check right before
  // dispatch is what actually prevents the double answer.
  it('does not answer a message the live path already answered during this very scan', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    const raceMessage = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({
      id: 'chan-1',
      fetchImpl: async () => {
        // Simulate the live path answering this exact message concurrently,
        // between this scan's own `handledIds` snapshot and this decision's
        // dispatch.
        discordHandledMessages.recordHandledMessage(
          {
            messageId: raceMessage.id,
            serverId: guildId,
            channelId: 'chan-1',
            handledAt: Date.now(),
          },
          testDb.db
        )
        return new Map([[raceMessage.id, raceMessage]])
      },
    })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(model.calls).toHaveLength(0)
    expect(raceMessage.reply).not.toHaveBeenCalled()
  })

  // SURF-9 follow-up — the gateway-hydration window: discord.js queues a
  // non-whitelisted dispatch while `status !== Status.Ready` and drains it
  // only *after* `triggerClientReady()`, which is after `sessionStart` is
  // captured here. A message from that window has `createdTimestamp <
  // sessionStart` (passes MF-C's own upper bound) but its live handling
  // only *starts* after this scan already began — after the `handledIds`
  // snapshot below, and (until it finishes) before
  // `discord_handled_messages` has a row either. `deps.inFlight` is the
  // only thing that can catch it; an otherwise identical message in
  // neither the set nor the table still dispatches normally.
  it('does not dispatch a message whose live handling has begun but not yet recorded (gateway-hydration window)', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    const inFlightMessage = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> in-flight question',
      createdTimestamp: now - 1_000,
    })
    const freeMessage = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> free question',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({
      id: 'chan-1',
      messages: [inFlightMessage, freeMessage],
    })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()
    const inFlight = createInFlightMessageIds()
    // Claimed by the live path (`message-handler.ts`) — no
    // `discord_handled_messages` row yet, so neither existing guard sees it.
    inFlight.add(inFlightMessage.id)

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
      inFlight,
    })

    expect(inFlightMessage.reply).not.toHaveBeenCalled()
    expect(freeMessage.reply).toHaveBeenCalledTimes(1)
    expect(model.calls).toHaveLength(1)
  })

  // MF4 — an apology only where an answer could actually have happened
  // live: a message matching no course gets silence live (`unrouted`), so it
  // must get silence here too, not an apology beneath nothing.
  it('withholds the apology for a message that would not route to any course', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 700_000)

    const message = fakeMessage({
      guildId,
      categoryName: 'Not A Real Category',
      content: '<@bot-1> question',
      createdTimestamp: now - 650_000, // older than answerMaxAgeMs, within lookback — decides `apologise`
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(message.reply).not.toHaveBeenCalled()
    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      false
    )
  })

  it('sends the apology for a message that does route to an enabled course', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 700_000)

    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 650_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(message.reply).toHaveBeenCalledTimes(1)
    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      true
    )
  })

  // SURF-9 rework round 2, MF-D — a REST-fetched message carries no
  // `member` payload; a role-routed course must still route once the real
  // member is resolved (`guild.members.fetch`), not decide `unrouted`.
  it("resolves the author's guild member explicitly and still routes a role-routed course", async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'No Category Routing',
      studentsRole: 'students-wd',
      adminsRole: 'admins-wd',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    // No category on the message at all — this can only route by role,
    // which needs a real member with the role, not `message.member: null`.
    const message = fakeMessage({
      guildId,
      categoryName: null,
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const member = fakeGuildMember({ roleNames: ['students-wd'] })
    const guild = fakeGuild({ id: guildId, channels: [channel], member })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(guild.members.fetch).toHaveBeenCalledWith(message.author.id)
    expect(model.calls).toHaveLength(1)
    expect(message.reply).toHaveBeenCalledTimes(1)
  })

  // MF-D — when the member genuinely cannot be resolved, the message is
  // skipped *without* being recorded, so a later scan can still retry it.
  it("skips without recording when the author's guild member cannot be resolved at all", async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({
      id: guildId,
      channels: [channel],
      membersFetchRejects: true,
    })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    expect(model.calls).toHaveLength(0)
    expect(message.reply).not.toHaveBeenCalled()
    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      false
    )
  })

  // Cheap-fix — the summary line's own `answered` count must reflect actual
  // answers, not every "answer"-decided candidate regardless of what
  // `handleMention` actually did with it.
  it('does not count a silently-unrouted "answer" decision toward the summary log\'s own answered total', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    // Addresses the bot, recent enough to decide `answer` — but a category
    // no course routes to, so `handleMention` itself returns `unrouted`.
    const message = fakeMessage({
      guildId,
      categoryName: 'Not A Real Category',
      content: '<@bot-1> hello?',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await runCatchUp(client, {
      ...baseDeps(testDb, model, logger),
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
    })

    const summary = logger.infoCalls.find(
      (call) => call[1] === 'apps/bot: catch-up scan complete'
    )
    expect(summary?.[0]).toMatchObject({ answered: 0 })
  })

  // Bounded and non-fatal — a channel whose fetch throws must not stop the
  // scan, and must not escape this function.
  it('logs and continues past a channel whose fetch throws, without escaping runCatchUp', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    const okMessage = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    const throwingChannel = fakeChannel({
      id: 'chan-throws',
      fetchImpl: async () => {
        throw new Error('simulated permission error')
      },
    })
    const okChannel = fakeChannel({ id: 'chan-ok', messages: [okMessage] })
    const guild = fakeGuild({
      id: guildId,
      channels: [throwingChannel, okChannel],
    })
    const client = fakeReadyClient({ botId: 'bot-1', guilds: [guild] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await expect(
      runCatchUp(client, {
        ...baseDeps(testDb, model, logger),
        bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
      })
    ).resolves.toBeUndefined()

    expect(logger.errorCalls.length).toBeGreaterThan(0)
    // The second, well-behaved channel is still scanned and answered.
    expect(model.calls).toHaveLength(1)
  })
})

describe('wireCatchUp (SURF-9 rework round 2, MF-A)', () => {
  it('registers on both Events.ShardReady and Events.ClientReady', () => {
    const on = vi.fn()
    const once = vi.fn()
    const fakeClient = { on, once, user: null } as unknown as Parameters<
      typeof wireCatchUp
    >[0]

    wireCatchUp(fakeClient, {
      db: undefined as never,
      model: undefined as never,
      logger: createFakeLogger(),
      admission: undefined as never,
      pricing: PRICING,
      connectUrl: 'https://app.bloombot.test',
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
      inFlight: createInFlightMessageIds(),
    })

    expect(on).toHaveBeenCalledWith(Events.ShardReady, expect.any(Function))
    expect(once).toHaveBeenCalledWith(Events.ClientReady, expect.any(Function))
  })

  // MF-A — the actual bug: on a cold process start, `client.isReady()` is
  // still `false` at the moment `Events.ShardReady` fires (discord.js emits
  // it from its own `AllReady` handling *before* `checkShardsReady()`/
  // `triggerClientReady()` — the only place `ws.status` becomes
  // `Status.Ready` — ever runs), even though `client.user` is already
  // populated by then. A version gated on `isReady()` never scans on the
  // very restart this requirement exists for; this proves a scan runs
  // anyway, from `client.user` alone.
  it('runs a scan on a cold process start, even though isReady() is not yet true when ShardReady fires', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    const channel = fakeChannel({ id: 'chan-1', messages: [message] })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    let shardReadyHandler: ((shardId: number) => void) | undefined
    const fakeClient = {
      user: { id: 'bot-1', username: 'Bloombot' },
      guilds: { cache: new Map([[guildId, guild]]) },
      // The bug this test exists to catch: `isReady()` still reports
      // `false` at the exact moment `ShardReady` fires on a cold start.
      isReady: () => false,
      on: vi.fn((event: string, handler: (shardId: number) => void) => {
        if (event === Events.ShardReady) shardReadyHandler = handler
      }),
      once: vi.fn(),
    } as unknown as Parameters<typeof wireCatchUp>[0]

    wireCatchUp(fakeClient, {
      db: testDb.db,
      model,
      logger,
      admission: createAdmissionGate({ limit: 5, waitMs: 1000 }),
      pricing: PRICING,
      connectUrl: 'https://app.bloombot.test',
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
      inFlight: createInFlightMessageIds(),
    })

    shardReadyHandler?.(0)

    await vi.waitFor(() => {
      expect(model.calls).toHaveLength(1)
    })
    expect(message.reply).toHaveBeenCalledTimes(1)
  })

  it('does not run the scan at all when client.user is genuinely unset', async () => {
    let shardReadyHandler: ((shardId: number) => void) | undefined
    const logger = createFakeLogger()
    const fakeClient = {
      user: null,
      isReady: () => false,
      on: vi.fn((event: string, handler: (shardId: number) => void) => {
        if (event === Events.ShardReady) shardReadyHandler = handler
      }),
      once: vi.fn(),
    } as unknown as Parameters<typeof wireCatchUp>[0]

    wireCatchUp(fakeClient, {
      db: undefined as never,
      model: undefined as never,
      logger,
      admission: undefined as never,
      pricing: PRICING,
      connectUrl: 'https://app.bloombot.test',
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
      inFlight: createInFlightMessageIds(),
    })

    expect(() => shardReadyHandler?.(0)).not.toThrow()
    expect(logger.errorCalls.length).toBeGreaterThan(0)
  })

  // MF-A — the shared in-flight guard: both events firing for the very same
  // cold-start session (ShardReady, then ClientReady moments later) must
  // still only scan once, not overlap into two concurrent scans.
  it('does not start a second overlapping scan when both ShardReady and ClientReady fire for the same session', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const now = Date.now()
    seedConnectedMarker(testDb, now - 200_000)

    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: '<@bot-1> question',
      createdTimestamp: now - 1_000,
    })
    // A `fetchImpl` that never resolves on its own keeps the first scan
    // "in flight" for the whole test, so firing the second event while it
    // is still running actually exercises the guard rather than racing a
    // scan that already finished.
    let resolveFetch: (() => void) | undefined
    const channel = fakeChannel({
      id: 'chan-1',
      fetchImpl: () =>
        new Promise((resolve) => {
          resolveFetch = () => resolve(new Map([[message.id, message]]))
        }),
    })
    const guild = fakeGuild({ id: guildId, channels: [channel] })
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    let shardReadyHandler: ((shardId: number) => void) | undefined
    let clientReadyHandler: (() => void) | undefined
    const fakeClient = {
      user: { id: 'bot-1', username: 'Bloombot' },
      guilds: { cache: new Map([[guildId, guild]]) },
      isReady: () => false,
      on: vi.fn((event: string, handler: (shardId: number) => void) => {
        if (event === Events.ShardReady) shardReadyHandler = handler
      }),
      once: vi.fn((event: string, handler: () => void) => {
        if (event === Events.ClientReady) clientReadyHandler = handler
      }),
    } as unknown as Parameters<typeof wireCatchUp>[0]

    wireCatchUp(fakeClient, {
      db: testDb.db,
      model,
      logger,
      admission: createAdmissionGate({ limit: 5, waitMs: 1000 }),
      pricing: PRICING,
      connectUrl: 'https://app.bloombot.test',
      bounds: { answerMaxAgeMs: 600_000, lookbackMs: 86_400_000 },
      inFlight: createInFlightMessageIds(),
    })

    shardReadyHandler?.(0)
    await vi.waitFor(() => {
      expect(channel.messages.fetch).toHaveBeenCalledTimes(1)
    })
    // Fires while the first scan's own fetch is still pending.
    clientReadyHandler?.()

    resolveFetch?.()
    await vi.waitFor(() => {
      expect(model.calls).toHaveLength(1)
    })

    // Only ever fetched once — the second trigger was suppressed by the
    // in-flight guard, not merely coincidentally harmless.
    expect(channel.messages.fetch).toHaveBeenCalledTimes(1)
  })
})
