/**
 * `handleMention` (SURF-1..6): the whole Discord surface, exercised against
 * a throwaway `tmp/` database and a fake model client — no discord.js, no
 * network. Each test below fails without the code named in its own
 * requirement id: see the report for how each was confirmed.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { people } from '@bloombot/db'

import {
  handleMention,
  type HandleMentionDependencies,
} from '../src/handle-mention.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { FakeModelClient } from './helpers/fake-model-client.js'
import { createFakeReplyPort } from './helpers/fake-reply-port.js'
import { BOT_ID, inboundMention } from './helpers/fixtures.js'
import { seedBoundServerWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Builds `handleMention`'s dependencies against a fresh model/reply/logger set for one test. */
function makeDeps(
  testDatabase: TestDatabase,
  overrides: Partial<HandleMentionDependencies> = {}
): {
  deps: HandleMentionDependencies
  model: FakeModelClient
  logger: ReturnType<typeof createFakeLogger>
  reply: ReturnType<typeof createFakeReplyPort>
} {
  const model = overrides.model ?? new FakeModelClient()
  const logger = createFakeLogger()
  const reply = createFakeReplyPort()
  return {
    model: model as FakeModelClient,
    logger,
    reply,
    deps: {
      db: testDatabase.db,
      model,
      logger,
      reply,
      day: '2026-01-01',
      ...overrides,
    },
  }
}

describe('handleMention — SURF-2: only a direct mention is answered', () => {
  it("ignores the bot's own message, before any database or model call", async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model, reply } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({
        guildId,
        authorId: BOT_ID,
        text: `<@${BOT_ID}> talking to myself`,
      }),
      deps
    )

    expect(result).toEqual({ kind: 'ignored-self' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
  })

  it("ignores another bot's message, even though it mentions this bot", async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model, reply } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({
        guildId,
        authorId: 'some-other-bot',
        authorIsBot: true,
      }),
      deps
    )

    expect(result).toEqual({ kind: 'ignored-other-bot' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
  })

  it('ignores a message that does not mention the bot at all', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model, reply } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({ guildId, text: 'just chatting with another student' }),
      deps
    )

    expect(result).toEqual({ kind: 'ignored-not-a-mention' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
  })

  it('answers a genuine mention, and the model receives the rewritten name while the transcript keeps what the student typed', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({ guildId, text: `<@${BOT_ID}> When is the midterm?` }),
      deps
    )

    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
    // BOT-6 — the model sees the readable name, never the raw snowflake token.
    expect(model.calls[0]?.question).toBe('@Bloombot When is the midterm?')
  })
})

describe('handleMention — SURF-3: a server not bound to an organization is ignored', () => {
  it('drops a message from an unbound guild, logging the cause, with no model call', async () => {
    testDb = createTestDatabase()
    const { deps, model, reply, logger } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({ guildId: 'never-bound-guild' }),
      deps
    )

    expect(result).toEqual({ kind: 'unbound-server' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })

  it('answers a message from a bound guild', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
  })
})

describe('handleMention — SURF-4: a person is recognized by their Discord account', () => {
  it('creates a person and identity on the first message, and reuses them on the second', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps: deps1 } = makeDeps(testDb)
    const { deps: deps2 } = makeDeps(testDb)

    await handleMention(
      inboundMention({ guildId, authorId: 'student-1' }),
      deps1
    )
    await handleMention(
      inboundMention({ guildId, authorId: 'student-1' }),
      deps2
    )

    const everyone = people.listPeople(organizationId, testDb.db)
    expect(everyone).toHaveLength(1)
  })

  it('keeps two different authors as two different people', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps: deps1 } = makeDeps(testDb)
    const { deps: deps2 } = makeDeps(testDb)

    await handleMention(
      inboundMention({ guildId, authorId: 'student-1' }),
      deps1
    )
    await handleMention(
      inboundMention({ guildId, authorId: 'student-2' }),
      deps2
    )

    const everyone = people.listPeople(organizationId, testDb.db)
    expect(everyone).toHaveLength(2)
  })
})

describe('handleMention — SURF-5: the reply is sent through the port, and a long answer is split', () => {
  it('sends the answer through `reply`, not any other channel', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const model = new FakeModelClient({ answerText: 'a short answer' })
    const { deps, reply } = makeDeps(testDb, { model })

    await handleMention(inboundMention({ guildId }), deps)

    expect(reply.sent).toEqual(['a short answer'])
  })

  it('splits an answer over the Discord limit into more than one message, in order, with nothing lost', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const longAnswer = 'word '.repeat(500) + 'end' // well over 2000 characters
    const model = new FakeModelClient({ answerText: longAnswer })
    const { deps, reply } = makeDeps(testDb, { model })

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
    expect(reply.sent.length).toBeGreaterThan(1)
    for (const part of reply.sent) {
      expect(part.length).toBeLessThanOrEqual(2000)
    }
    // Reassembling the parts loses nothing.
    expect(reply.sent.join('')).toBe(longAnswer)
  })
})

describe('handleMention — SURF-6: every outcome reaches the student or the log', () => {
  it('renders "answered"', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, reply } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
    expect(reply.sent).toHaveLength(1)
  })

  it('renders "answered-last-request", with the day\'s-last notice in the reply', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      maxRequestsPerDay: 1,
    })
    const { deps, reply } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered-last-request')
    expect(reply.sent[0]).toMatch(/reached the maximum number of responses/)
  })

  it('renders "declined-over-limit" as a refusal reaching the student, not silence', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      maxRequestsPerDay: 1,
    })
    const model = new FakeModelClient()
    const { deps: firstDeps } = makeDeps(testDb, { model })
    const { deps: secondDeps, reply } = makeDeps(testDb, { model })

    await handleMention(inboundMention({ guildId }), firstDeps) // reaches the limit
    const result = await handleMention(inboundMention({ guildId }), secondDeps) // over it

    expect(result).toEqual({ kind: 'declined-over-limit' })
    expect(model.calls).toHaveLength(1) // the second request never reached the model
    expect(reply.sent).toHaveLength(1)
    expect(reply.sent[0]).toMatch(/reached the maximum number of responses/)
  })

  it('renders "failed-with-apology" when the model call fails', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const model = new FakeModelClient()
    model.failNext()
    const { deps, reply } = makeDeps(testDb, { model })

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('failed-with-apology')
    expect(reply.sent[0]).toMatch(/can't respond intelligently/)
  })

  it('logs and stays silent for a course configured to answer nothing', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      instructions: null,
      promptId: null,
    })
    const { deps, reply, logger } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result).toEqual({ kind: 'not-configured' })
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })

  // `answerQuestion`'s own `course-disabled` result exists for a caller that
  // reaches it without going through routing (its own comment: "CORE-2's
  // routing already filters a disabled course out for the Discord
  // adapter"). `routeMessage` drops a disabled course before it can ever
  // match, so a disabled course reaches `handleMention` as `unrouted`, not
  // `course-disabled` — asserted here so that stays true rather than
  // assumed.
  it('routes around a disabled course entirely — it never reaches answerQuestion at all', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, { enabled: false })
    const { deps, model, reply, logger } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result).toEqual({ kind: 'unrouted' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })

  it('logs and stays silent for a message that matches no course', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Some Other Category',
    })
    const { deps, reply, logger } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({
        guildId,
        categoryName: 'Uncategorized',
        authorRoleNames: [],
      }),
      deps
    )

    expect(result).toEqual({ kind: 'unrouted' })
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })
})
