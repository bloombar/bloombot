/**
 * `createOpenAiModelClient` — the whole adapter exercised through
 * `ModelClient.ask` (`@bloombot/core`'s port) against the in-process fake
 * (MDL-2, MDL-3, MDL-4, MDL-5), never a real network call (MDL-7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetConfigCache } from '@bloombot/config'
import {
  ModelAskError,
  type ModelClient,
  type ModelRequest,
} from '@bloombot/core'

import { createOpenAiModelClient } from '../src/client.js'
import { ModelRequestError } from '../src/errors.js'
import {
  fakeResponsesPayload,
  FakeOpenAiServer,
} from './helpers/fake-openai-server.js'
import { createFakeLogger, type FakeLogger } from './helpers/fake-logger.js'

/** A complete `ModelRequest` with every field, so each test only overrides what it cares about. */
function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    promptId: null,
    instructions: 'Be helpful.',
    vectorStoreId: null,
    model: null,
    upstreamThreadId: null,
    question: 'When is the midterm?',
    // Finding 1 of the MDL-1 rework — `null` here by default so the
    // existing tests above keep exercising the generic-opener path;
    // `describe('finding 1 ...')` below overrides these to prove they are
    // threaded through.
    displayName: null,
    courseTitle: null,
    personIdentifier: null,
    addressAs: null,
    ...overrides,
  }
}

describe('createOpenAiModelClient', () => {
  let server: FakeOpenAiServer
  let logger: FakeLogger
  let client: ModelClient

  beforeEach(async () => {
    server = await FakeOpenAiServer.start()
    logger = createFakeLogger()
    client = createOpenAiModelClient({
      apiKey: 'test-key',
      baseUrl: server.baseUrl,
      timeoutMs: 2000,
      logger,
      fetchFn: fetch,
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('MDL-2: stored prompt vs. inline instructions', () => {
    it('sends the stored-prompt shape for a course with a promptId', async () => {
      server.respondToConversations({ status: 200, body: { id: 'conv_1' } })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      await client.ask(
        baseRequest({ promptId: 'pmpt_1', instructions: 'ignored' })
      )

      const responsesRequest = server.requests.find(
        (r) => r.path === '/responses'
      )!
      const body = responsesRequest.body as Record<string, unknown>
      expect(body.prompt).toEqual({ id: 'pmpt_1' })
      expect(body.instructions).toBeUndefined()
    })

    it('sends instructions inline for a course with no promptId', async () => {
      server.respondToConversations({ status: 200, body: { id: 'conv_1' } })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      await client.ask(
        baseRequest({
          promptId: null,
          instructions: 'Answer from the syllabus.',
        })
      )

      const responsesRequest = server.requests.find(
        (r) => r.path === '/responses'
      )!
      const body = responsesRequest.body as Record<string, unknown>
      expect(body.instructions).toBe('Answer from the syllabus.')
      expect(body.prompt).toBeUndefined()
    })
  })

  describe('MDL-3: file search only when the course has a vector store', () => {
    it("sends the file_search tool with the course's store id", async () => {
      server.respondToConversations({ status: 200, body: { id: 'conv_1' } })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      await client.ask(baseRequest({ vectorStoreId: 'vs_course_1' }))

      const responsesRequest = server.requests.find(
        (r) => r.path === '/responses'
      )!
      const body = responsesRequest.body as Record<string, unknown>
      expect(body.tools).toEqual([
        { type: 'file_search', vector_store_ids: ['vs_course_1'] },
      ])
    })

    it('sends no tool at all for a course with no vector store', async () => {
      server.respondToConversations({ status: 200, body: { id: 'conv_1' } })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      await client.ask(baseRequest({ vectorStoreId: null }))

      const responsesRequest = server.requests.find(
        (r) => r.path === '/responses'
      )!
      const body = responsesRequest.body as Record<string, unknown>
      expect(body.tools).toBeUndefined()
    })
  })

  describe('MDL-4: conversation continuity', () => {
    it('creates a conversation first when there is no stored thread id, and uses its id on the answer request', async () => {
      server.respondToConversations({
        status: 200,
        body: { id: 'conv_brand_new' },
      })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      const answer = await client.ask(baseRequest({ upstreamThreadId: null }))

      expect(server.requests[0]!.path).toBe('/conversations')
      const responsesRequest = server.requests.find(
        (r) => r.path === '/responses'
      )!
      expect(
        (responsesRequest.body as Record<string, unknown>).conversation
      ).toBe('conv_brand_new')
      // The new id is returned for the platform to persist.
      expect(answer.upstreamThreadId).toBe('conv_brand_new')
    })

    it('reuses a stored thread id with no create call, and returns null for upstreamThreadId', async () => {
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      const answer = await client.ask(
        baseRequest({ upstreamThreadId: 'conv_existing' })
      )

      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]!.path).toBe('/responses')
      expect(
        (server.requests[0]!.body as Record<string, unknown>).conversation
      ).toBe('conv_existing')
      expect(answer.upstreamThreadId).toBeNull()
    })

    it('starts a new conversation and retries exactly once when the stored id is rejected as unknown', async () => {
      server.respondToResponses({
        status: 404,
        body: {
          error: {
            message: 'No conversation found with id conv_gone',
            code: 'conversation_not_found',
          },
        },
      })
      server.respondToConversations({
        status: 200,
        body: { id: 'conv_replacement' },
      })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      const answer = await client.ask(
        baseRequest({ upstreamThreadId: 'conv_gone' })
      )

      // Exactly one create call and two responses calls (the failed one and the retry).
      const conversationCalls = server.requests.filter(
        (r) => r.path === '/conversations'
      )
      const responsesCalls = server.requests.filter(
        (r) => r.path === '/responses'
      )
      expect(conversationCalls).toHaveLength(1)
      expect(responsesCalls).toHaveLength(2)
      expect(
        (responsesCalls[1]!.body as Record<string, unknown>).conversation
      ).toBe('conv_replacement')
      expect(answer.upstreamThreadId).toBe('conv_replacement')
      expect(answer.text).toBe('the answer')
    })
  })

  describe('MDL-5: bounds and one retry', () => {
    it('answers on the retry after a single 500', async () => {
      server.respondToResponses({
        status: 500,
        body: { error: { message: 'temporary outage' } },
      })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('recovered answer', {
          input_tokens: 5,
          output_tokens: 9,
        }),
      })

      const answer = await client.ask(
        baseRequest({ upstreamThreadId: 'conv_1' })
      )

      expect(answer.text).toBe('recovered answer')
      expect(answer.usage).toEqual({ inputTokens: 5, outputTokens: 9 })
      const responsesCalls = server.requests.filter(
        (r) => r.path === '/responses'
      )
      expect(responsesCalls).toHaveLength(2)
    })

    it('does not retry a 400 — the request fails immediately', async () => {
      server.respondToResponses({
        status: 400,
        body: { error: { message: 'invalid request' } },
      })

      await expect(
        client.ask(baseRequest({ upstreamThreadId: 'conv_1' }))
      ).rejects.toThrow(/invalid request/)

      const responsesCalls = server.requests.filter(
        (r) => r.path === '/responses'
      )
      expect(responsesCalls).toHaveLength(1)
    })

    it('abandons a request that outlives the timeout, with a classified timeout error', async () => {
      // A timeout is retryable (MDL-5), so both the original attempt and
      // its one retry need to be slow here — otherwise the retry would
      // land on the fake's fast default response and this test would prove
      // nothing about the timeout path.
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('too slow'),
        delayMs: 500,
      })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('still too slow'),
        delayMs: 500,
      })
      const shortTimeoutClient = createOpenAiModelClient({
        apiKey: 'test-key',
        baseUrl: server.baseUrl,
        timeoutMs: 30,
        logger,
        fetchFn: fetch,
      })

      await expect(
        shortTimeoutClient.ask(baseRequest({ upstreamThreadId: 'conv_1' }))
      ).rejects.toThrow(/did not complete within/)
    })

    it('returns the token counts the fake reported', async () => {
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('answer', {
          input_tokens: 111,
          output_tokens: 222,
        }),
      })

      const answer = await client.ask(
        baseRequest({ upstreamThreadId: 'conv_1' })
      )

      expect(answer.usage).toEqual({ inputTokens: 111, outputTokens: 222 })
    })

    it('omits usage entirely when the provider reported none', async () => {
      // Finding 5 of the MDL-1 rework — this used to be `{ output: [{
      // type: 'message', content: [] }] }`, an empty-content payload that
      // extracts to no answer text at all and now fails the turn
      // (`describe('finding 5 ...')`, below) rather than returning
      // successfully. This test's own job is "usage omitted", so the
      // payload here has real answer text and simply no `usage` field.
      server.respondToResponses({
        status: 200,
        body: {
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'answer with no usage' }],
            },
          ],
        },
      })

      const answer = await client.ask(
        baseRequest({ upstreamThreadId: 'conv_1' })
      )

      expect(answer.text).toBe('answer with no usage')
      expect(answer.usage).toBeUndefined()
      expect('usage' in answer).toBe(false)
    })
  })

  describe('MDL-6: citation markers are stripped from the returned answer', () => {
    it('strips markers before returning the text', async () => {
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload(
          'The exam is Friday【4:0†syllabus.pdf】 and covers chapters 1-3【7:2†schedule.pdf】.'
        ),
      })

      const answer = await client.ask(
        baseRequest({ upstreamThreadId: 'conv_1' })
      )

      expect(answer.text).toBe('The exam is Friday and covers chapters 1-3.')
    })
  })

  describe('MDL-7: baseUrl defaults from CONFIG.OPENAI_BASE_URL, not a literal', () => {
    beforeEach(() => {
      resetConfigCache()
      process.env.NODE_ENV = 'test'
      process.env.PUBLIC_APP_URL = 'https://bloombot.example.edu'
    })

    afterEach(() => {
      resetConfigCache()
      delete process.env.OPENAI_BASE_URL
      delete process.env.PUBLIC_APP_URL
    })

    it('reaches the fake when OPENAI_BASE_URL is set and baseUrl is omitted', async () => {
      process.env.OPENAI_BASE_URL = server.baseUrl
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('answered via CONFIG default'),
      })

      // baseUrl, timeoutMs and fetchFn all omitted — every default (MDL-1's
      // options, `client.ts`) is exercised here, not just the base URL.
      const defaultClient = createOpenAiModelClient({
        apiKey: 'test-key',
        logger,
      })

      const answer = await defaultClient.ask(
        baseRequest({ upstreamThreadId: 'conv_1' })
      )

      expect(answer.text).toBe('answered via CONFIG default')
    })
  })

  describe('finding 1 of the MDL-1 rework: the seeded opening item comes from the request', () => {
    it("seeds the new conversation with the request's displayName, courseTitle and addressAs, and carries personIdentifier only in metadata (CORE-7/CORE-8)", async () => {
      server.respondToConversations({
        status: 200,
        body: { id: 'conv_seeded' },
      })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      // `addressAs` and `personIdentifier` given deliberately different
      // values here, not the same string twice — the only way this test
      // can actually prove the seeded content and the metadata are sourced
      // independently (`ports.ts`'s own comment on why the split exists).
      await client.ask(
        baseRequest({
          upstreamThreadId: null,
          displayName: 'Ada Lovelace',
          courseTitle: 'Intro to Algorithms',
          addressAs: '<@123>',
          personIdentifier: '123',
        })
      )

      const conversationRequest = server.requests.find(
        (r) => r.path === '/conversations'
      )!
      expect(conversationRequest.body).toEqual({
        items: [
          {
            role: 'user',
            content:
              'My name is Ada Lovelace (user id <@123>) and I am a student in the Intro to Algorithms course.',
          },
        ],
        metadata: { user_id: '123' },
      })
    })
  })

  describe('finding 3 of the MDL-1 rework: creating the conversation gets the same transient retry as the answer call', () => {
    it('retries once after a transient failure creating the conversation, then still answers', async () => {
      server.respondToConversations({
        status: 500,
        body: { error: { message: 'temporary outage' } },
      })
      server.respondToConversations({
        status: 200,
        body: { id: 'conv_after_retry' },
      })
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('the answer'),
      })

      const answer = await client.ask(baseRequest({ upstreamThreadId: null }))

      const conversationCalls = server.requests.filter(
        (r) => r.path === '/conversations'
      )
      expect(conversationCalls).toHaveLength(2)
      expect(answer.upstreamThreadId).toBe('conv_after_retry')
      expect(answer.text).toBe('the answer')
    })

    it('does not retry a non-transient failure creating the conversation, and never calls /responses', async () => {
      server.respondToConversations({
        status: 400,
        body: { error: { message: 'invalid request' } },
      })

      await expect(
        client.ask(baseRequest({ upstreamThreadId: null }))
      ).rejects.toThrow(/invalid request/)

      const conversationCalls = server.requests.filter(
        (r) => r.path === '/conversations'
      )
      const responsesCalls = server.requests.filter(
        (r) => r.path === '/responses'
      )
      expect(conversationCalls).toHaveLength(1)
      expect(responsesCalls).toHaveLength(0)
    })
  })

  describe('finding 4 of the MDL-1 rework: a 2xx with an empty body is a classified error, not a raw TypeError', () => {
    it('rejects with a ModelRequestError rather than an unclassified TypeError', async () => {
      // A reused thread id (no create call) keeps this test isolated to
      // finding 4 alone — an id freshly created on this same call would
      // additionally wrap the error in a `ModelAskError` (finding 6,
      // exercised separately below), which is not what this test is about.
      // `FakeOpenAiServer` writes `JSON.stringify(result.body)`, which is
      // `undefined` for `body: undefined` — `res.end(undefined)` ends the
      // response with no body at all, the real "2xx, empty body" shape.
      server.respondToResponses({ status: 200, body: undefined })

      const rejection = client.ask(baseRequest({ upstreamThreadId: 'conv_1' }))
      await expect(rejection).rejects.toBeInstanceOf(ModelRequestError)
      await expect(rejection).rejects.toThrow(/no usable JSON body/)
    })
  })

  describe('finding 5 of the MDL-1 rework: an empty extracted answer fails the turn rather than returning a blank reply', () => {
    it('rejects rather than resolving with `text: ""`', async () => {
      server.respondToResponses({
        status: 200,
        body: { output: [{ type: 'message', content: [] }] },
      })

      await expect(
        client.ask(baseRequest({ upstreamThreadId: 'conv_1' }))
      ).rejects.toThrow(/no answer text/)
    })
  })

  describe('finding 6 of the MDL-1 rework: a conversation id created just before a failure is not lost', () => {
    it('carries the freshly created id on a `ModelAskError` when the first turn fails outright', async () => {
      server.respondToConversations({
        status: 200,
        body: { id: 'conv_first_turn' },
      })
      server.respondToResponses({
        status: 500,
        body: { error: { message: 'down' } },
      })
      server.respondToResponses({
        status: 500,
        body: { error: { message: 'still down' } },
      })

      const rejection = client.ask(baseRequest({ upstreamThreadId: null }))
      await expect(rejection).rejects.toBeInstanceOf(ModelAskError)
      await rejection.catch((error: unknown) => {
        expect(
          (error as InstanceType<typeof ModelAskError>).upstreamThreadId
        ).toBe('conv_first_turn')
      })

      const conversationCalls = server.requests.filter(
        (r) => r.path === '/conversations'
      )
      // No second create — a 500 is MDL-5's transient retry, not MDL-4's
      // recreate.
      expect(conversationCalls).toHaveLength(1)
    })

    it('preserves the id from a 404-recreate even when the retried call itself fails, and a later turn reuses it instead of creating a third', async () => {
      // First turn: the stored id is rejected as unknown (MDL-4's
      // recreate), the recreate succeeds, and the retried answer call
      // fails twice (the attempt and its one transient retry) — the exact
      // sequence finding 6 names: "404, recreate, then a failure".
      server.respondToResponses({
        status: 404,
        body: {
          error: {
            message: 'No conversation found with id conv_gone',
            code: 'conversation_not_found',
          },
        },
      })
      server.respondToConversations({
        status: 200,
        body: { id: 'conv_replacement' },
      })
      server.respondToResponses({
        status: 500,
        body: { error: { message: 'down after recreating' } },
      })
      server.respondToResponses({
        status: 500,
        body: { error: { message: 'still down' } },
      })

      const firstTurn = client.ask(
        baseRequest({ upstreamThreadId: 'conv_gone' })
      )
      await expect(firstTurn).rejects.toBeInstanceOf(ModelAskError)
      await firstTurn.catch((error: unknown) => {
        expect(
          (error as InstanceType<typeof ModelAskError>).upstreamThreadId
        ).toBe('conv_replacement')
      })

      const conversationCallsAfterFirstTurn = server.requests.filter(
        (r) => r.path === '/conversations'
      )
      expect(conversationCallsAfterFirstTurn).toHaveLength(1)

      // `answer.ts` would have persisted `conv_replacement` from the
      // thrown error above; the next turn hands it back as
      // `upstreamThreadId` instead of `null`.
      server.respondToResponses({
        status: 200,
        body: fakeResponsesPayload('recovered on the second turn'),
      })
      const secondTurn = await client.ask(
        baseRequest({ upstreamThreadId: 'conv_replacement' })
      )

      expect(secondTurn.text).toBe('recovered on the second turn')
      // Still exactly one create call, total — the second turn reused the
      // id rather than creating a third conversation.
      const conversationCallsAfterSecondTurn = server.requests.filter(
        (r) => r.path === '/conversations'
      )
      expect(conversationCallsAfterSecondTurn).toHaveLength(1)
    })
  })
})
