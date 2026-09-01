/**
 * `conversations.ts` — `createUpstreamConversation` and its seed text,
 * against the in-process fake (MDL-4), never a real network call.
 *
 * `buildSeedText` is tested directly with a real display name and course
 * title to prove the module can seed the opening item correctly (MDL-4's
 * "seeded with who they are and which course they are in") — see this
 * file's module comment and `conversations.ts`'s own for why `client.ts`
 * cannot supply either today: `ModelRequest` (`@bloombot/core`'s
 * `src/ports.ts`) carries neither, and this slice's brief says not to widen
 * the port to add them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildSeedText,
  createUpstreamConversation,
} from '../src/conversations.js'
import { ModelRequestError } from '../src/errors.js'
import { FakeOpenAiServer } from './helpers/fake-openai-server.js'

describe('buildSeedText (MDL-4)', () => {
  it("states the person's name and the course when both are known", () => {
    expect(buildSeedText('Ada Lovelace', 'Intro to Algorithms')).toBe(
      'My name is Ada Lovelace and I am a student in the Intro to Algorithms course.'
    )
  })

  it('falls back to just the course when the name is unknown', () => {
    expect(buildSeedText(null, 'Intro to Algorithms')).toBe(
      'I am a student in the Intro to Algorithms course.'
    )
  })

  it('falls back to just the name when the course is unknown', () => {
    expect(buildSeedText('Ada Lovelace', null)).toBe('My name is Ada Lovelace.')
  })

  it('falls back to a generic opener when neither is known', () => {
    expect(buildSeedText(null, null)).toBe('Starting a new conversation.')
  })
})

describe('createUpstreamConversation (MDL-4)', () => {
  let server: FakeOpenAiServer

  beforeEach(async () => {
    server = await FakeOpenAiServer.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('POSTs to /conversations with the seeded opening item and metadata, and returns the id', async () => {
    server.respondToConversations({ status: 200, body: { id: 'conv_new_1' } })

    const id = await createUpstreamConversation({
      fetchFn: fetch,
      baseUrl: server.baseUrl,
      apiKey: 'test-key',
      timeoutMs: 1000,
      displayName: 'Ada Lovelace',
      courseTitle: 'Intro to Algorithms',
      personRef: '<@123>',
    })

    expect(id).toBe('conv_new_1')
    expect(server.requests).toHaveLength(1)
    const request = server.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/conversations')
    expect(request.headers.authorization).toBe('Bearer test-key')
    expect(request.body).toEqual({
      items: [
        {
          role: 'user',
          content:
            'My name is Ada Lovelace and I am a student in the Intro to Algorithms course.',
        },
      ],
      metadata: { user_id: '<@123>' },
    })
  })

  it('omits metadata entirely when personRef is null', async () => {
    server.respondToConversations({ status: 200, body: { id: 'conv_new_2' } })

    await createUpstreamConversation({
      fetchFn: fetch,
      baseUrl: server.baseUrl,
      apiKey: 'test-key',
      timeoutMs: 1000,
      displayName: null,
      courseTitle: null,
      personRef: null,
    })

    const request = server.requests[0]!
    expect(request.body).toEqual({
      items: [{ role: 'user', content: 'Starting a new conversation.' }],
    })
  })

  it('throws a classified ModelRequestError on a non-2xx response', async () => {
    server.respondToConversations({
      status: 500,
      body: { error: { message: 'upstream exploded' } },
    })

    await expect(
      createUpstreamConversation({
        fetchFn: fetch,
        baseUrl: server.baseUrl,
        apiKey: 'test-key',
        timeoutMs: 1000,
        displayName: null,
        courseTitle: null,
        personRef: null,
      })
    ).rejects.toBeInstanceOf(ModelRequestError)
  })
})
