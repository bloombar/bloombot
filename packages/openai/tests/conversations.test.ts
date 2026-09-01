/**
 * `conversations.ts` — `createUpstreamConversation` and its seed text,
 * against the in-process fake (MDL-4), never a real network call.
 *
 * `buildSeedText` is tested directly against every combination of a real
 * display name, course title and identity reference (MDL-4's "seeded with
 * who they are and which course they are in", finding 1 of the MDL-1
 * rework) — `client.ts` now threads all three straight through from
 * `ModelRequest` (`@bloombot/core`'s `src/ports.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildSeedText,
  createUpstreamConversation,
} from '../src/conversations.js'
import { ModelRequestError } from '../src/errors.js'
import { FakeOpenAiServer } from './helpers/fake-openai-server.js'

describe('buildSeedText (MDL-4)', () => {
  it('states the name (with the identity reference), the id and the course when all three are known', () => {
    expect(buildSeedText('Ada Lovelace', 'Intro to Algorithms', '<@123>')).toBe(
      'My name is Ada Lovelace (user id <@123>) and I am a student in the Intro to Algorithms course.'
    )
  })

  it('omits the identity reference when only the name and course are known', () => {
    expect(buildSeedText('Ada Lovelace', 'Intro to Algorithms', null)).toBe(
      'My name is Ada Lovelace and I am a student in the Intro to Algorithms course.'
    )
  })

  it('falls back to just the course when the name is unknown, even with an identity reference', () => {
    expect(buildSeedText(null, 'Intro to Algorithms', '<@123>')).toBe(
      'I am a student in the Intro to Algorithms course.'
    )
  })

  it('falls back to just the name (with the identity reference) when the course is unknown', () => {
    expect(buildSeedText('Ada Lovelace', null, '<@123>')).toBe(
      'My name is Ada Lovelace (user id <@123>).'
    )
  })

  it('falls back to just the name when neither the course nor the identity reference is known', () => {
    expect(buildSeedText('Ada Lovelace', null, null)).toBe(
      'My name is Ada Lovelace.'
    )
  })

  it('falls back to a generic opener when nothing is known', () => {
    expect(buildSeedText(null, null, null)).toBe('Starting a new conversation.')
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
            'My name is Ada Lovelace (user id <@123>) and I am a student in the Intro to Algorithms course.',
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
