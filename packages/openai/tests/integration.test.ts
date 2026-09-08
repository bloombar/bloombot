/**
 * Integration: `answerQuestion` (`@bloombot/core`) wired to this adapter,
 * against the in-process fake upstream — the first test in the repo that
 * exercises the real pipeline with a real HTTP round trip (loopback only,
 * MDL-7). Proves the adapter satisfies `ModelClient` (`@bloombot/core`'s
 * `src/ports.ts`) well enough for the pipeline that actually calls it, not
 * just well enough to satisfy this package's own unit tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { answerQuestion } from '@bloombot/core'
import { conversations } from '@bloombot/db'

import { createOpenAiModelClient } from '../src/client.js'
import {
  fakeResponsesPayload,
  FakeOpenAiServer,
} from './helpers/fake-openai-server.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { seedCourseAndPerson } from './helpers/seed.js'
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

describe('answerQuestion wired to createOpenAiModelClient (MDL-1..7 integration)', () => {
  it('answers a question end to end and records both directions of the exchange', async () => {
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { instructions: 'Answer from the syllabus.' }
    )
    const logger = createFakeLogger()

    server.respondToConversations({ status: 200, body: { id: 'conv_e2e' } })
    server.respondToResponses({
      status: 200,
      body: fakeResponsesPayload(
        'The midterm is next Friday【4:0†syllabus.pdf】.'
      ),
    })

    const model = createOpenAiModelClient({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      logger,
      fetchFn: fetch,
    })

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'When is the midterm?',
        day: '2026-08-31',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('answered')
    if (result.kind !== 'answered') throw new Error('expected an answer')
    // MDL-6 — the citation marker never reached the caller.
    expect(result.text).toBe('The midterm is next Friday.')

    // CORE-6/CONV-2 — both directions were recorded against the same conversation.
    const transcript = conversations.getTranscript(
      organizationId,
      result.conversationId,
      testDb.db
    )
    expect(transcript.map((m) => m.direction)).toEqual([
      'from_person',
      'to_person',
    ])
    expect(transcript[0]!.content).toBe('When is the midterm?')
    expect(transcript[1]!.content).toBe('The midterm is next Friday.')

    // MDL-4 — the upstream conversation id the adapter created is what
    // answer.ts persisted for the platform's own conversation row.
    const conversation = conversations.getConversation(
      organizationId,
      result.conversationId,
      testDb.db
    )
    expect(conversation?.upstreamThreadId).toBe('conv_e2e')
  })
})
