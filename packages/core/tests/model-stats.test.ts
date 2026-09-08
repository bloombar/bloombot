/** COST-5's model call counter (`model-stats.ts`), exercised with no network. */

import { describe, expect, it } from 'vitest'

import { createCountingModelClient } from '../src/model-stats.js'
import type { ModelAnswer, ModelClient, ModelRequest } from '../src/ports.js'

const REQUEST: ModelRequest = {
  promptId: null,
  instructions: 'Be helpful.',
  vectorStoreId: null,
  webSourceDomains: [],
  model: null,
  upstreamThreadId: null,
  question: 'q',
  displayName: null,
  courseTitle: null,
  personIdentifier: null,
  addressAs: null,
}

function fakeClient(answer: () => Promise<ModelAnswer>): ModelClient {
  return { ask: answer }
}

describe('createCountingModelClient (COST-5)', () => {
  it('reports zero calls and a zero error rate before anything is asked', () => {
    const { getStats } = createCountingModelClient(
      fakeClient(() => Promise.reject(new Error('never called')))
    )

    expect(getStats()).toEqual({ calls: 0, errors: 0, errorRate: 0 })
  })

  it('counts a successful call without counting it as an error', async () => {
    const { client, getStats } = createCountingModelClient(
      fakeClient(() =>
        Promise.resolve({ text: 'ok', upstreamThreadId: null, model: 'm' })
      )
    )

    await client.ask(REQUEST)

    expect(getStats()).toEqual({ calls: 1, errors: 0, errorRate: 0 })
  })

  it('counts a failed call as both a call and an error, and still rethrows', async () => {
    const { client, getStats } = createCountingModelClient(
      fakeClient(() => Promise.reject(new Error('boom')))
    )

    await expect(client.ask(REQUEST)).rejects.toThrow('boom')

    expect(getStats()).toEqual({ calls: 1, errors: 1, errorRate: 1 })
  })

  it('computes a running error rate across mixed calls', async () => {
    let succeed = true
    const { client, getStats } = createCountingModelClient(
      fakeClient(() => {
        const shouldSucceed = succeed
        succeed = !succeed
        return shouldSucceed
          ? Promise.resolve({ text: 'ok', upstreamThreadId: null, model: 'm' })
          : Promise.reject(new Error('boom'))
      })
    )

    await client.ask(REQUEST)
    await expect(client.ask(REQUEST)).rejects.toThrow()
    await client.ask(REQUEST)
    await expect(client.ask(REQUEST)).rejects.toThrow()

    expect(getStats()).toEqual({ calls: 4, errors: 2, errorRate: 0.5 })
  })
})
