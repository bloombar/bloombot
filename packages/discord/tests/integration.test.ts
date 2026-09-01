/**
 * End to end: a mention, through `handleMention`, the real `answerQuestion`
 * (`@bloombot/core`), to the real OpenAI adapter (`@bloombot/openai`)
 * against its loopback fake — the first test in this package that exercises
 * the whole stack the way `apps/bot` will, proving `handleMention` satisfies
 * `answerQuestion` well enough for a real adapter, not just this package's
 * own `FakeModelClient`. Bound to `127.0.0.1:0`; no real network, no real
 * Discord.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { conversations } from '@bloombot/db'
import { createOpenAiModelClient } from '@bloombot/openai'

import { handleMention } from '../src/handle-mention.js'
import {
  fakeResponsesPayload,
  FakeOpenAiServer,
} from './helpers/fake-openai-server.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { createFakeReplyPort } from './helpers/fake-reply-port.js'
import { BOT_ID, inboundMention } from './helpers/fixtures.js'
import { seedBoundServerWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase
let server: FakeOpenAiServer

beforeEach(async () => {
  testDb = createTestDatabase()
  server = await FakeOpenAiServer.start()
})

afterEach(async () => {
  testDb.cleanup()
  await server.stop()
})

describe('handleMention wired to the real answerQuestion and OpenAI adapter (end to end)', () => {
  it('answers a mention and writes both directions of the exchange to the transcript', async () => {
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      instructions: 'Answer from the syllabus.',
    })
    const logger = createFakeLogger()
    const reply = createFakeReplyPort()

    server.respondToConversations({ status: 200, body: { id: 'conv_e2e' } })
    server.respondToResponses({
      status: 200,
      body: fakeResponsesPayload('The midterm is next Friday.'),
    })

    const model = createOpenAiModelClient({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      logger,
      fetchFn: fetch,
    })

    const result = await handleMention(
      inboundMention({
        guildId,
        text: `<@${BOT_ID}> When is the midterm?`,
      }),
      { db: testDb.db, model, logger, reply, day: '2026-08-31' }
    )

    expect(result.kind).toBe('answered')
    if (result.kind !== 'answered') throw new Error('expected an answer')
    expect(reply.sent).toEqual(['The midterm is next Friday.'])

    const transcript = conversations.getTranscript(
      organizationId,
      result.conversationId,
      testDb.db
    )
    expect(transcript.map((m) => m.direction)).toEqual([
      'from_person',
      'to_person',
    ])
    // The transcript keeps what the student actually typed, mention token
    // and all — not the rewritten `@Bloombot` the model was asked with.
    expect(transcript[0]?.content).toBe(`<@${BOT_ID}> When is the midterm?`)
    expect(transcript[1]?.content).toBe('The midterm is next Friday.')
  })
})
