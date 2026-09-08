/**
 * COST-5's monitoring read (`monitoring.ts`) — exercised with a fake
 * `fetch`, no real network (this file's own module comment: "no network
 * beyond loopback", proven here by never actually opening a socket at all).
 */

import { describe, expect, it } from 'vitest'

import { checkPlatformHealth } from '../src/monitoring.js'

const URLS = {
  botHealthUrl: 'http://127.0.0.1:3001',
  workerHealthUrl: 'http://127.0.0.1:3002',
  apiHealthUrl: 'http://127.0.0.1:3000/health',
}

/** A fake `fetch` that resolves per-URL from `responses`, and rejects (simulating a refused connection) for anything else. */
function fakeFetch(
  responses: Record<string, { status: number; body: unknown }>
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const response = responses[url]
    if (!response) {
      throw new Error(`fakeFetch: connection refused for ${url}`)
    }
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => response.body,
    } as Response
  }) as typeof fetch
}

describe('checkPlatformHealth (COST-5)', () => {
  it('reports each reachable process`s own status', async () => {
    const fetchFn = fakeFetch({
      [URLS.botHealthUrl]: {
        status: 200,
        body: {
          gatewayConnected: true,
          model: { calls: 3, errors: 0, errorRate: 0 },
        },
      },
      [URLS.workerHealthUrl]: {
        status: 200,
        body: { ready: true, database: true, queueDepth: 2 },
      },
      [URLS.apiHealthUrl]: {
        status: 200,
        body: { ready: true, database: true },
      },
    })

    const report = await checkPlatformHealth({ ...URLS, fetchFn })

    expect(report.bot).toEqual({
      reachable: true,
      status: {
        gatewayConnected: true,
        model: { calls: 3, errors: 0, errorRate: 0 },
      },
    })
    expect(report.worker).toEqual({
      reachable: true,
      status: { ready: true, database: true, queueDepth: 2 },
    })
    expect(report.api).toEqual({
      reachable: true,
      status: { ready: true, database: true },
    })
  })

  // COST-5's own text: "reports a process it cannot reach as unreachable
  // rather than healthy."
  it('reports a process it cannot reach as unreachable, not healthy, and still reports the other two', async () => {
    const fetchFn = fakeFetch({
      [URLS.workerHealthUrl]: {
        status: 200,
        body: { ready: true, database: true, queueDepth: 0 },
      },
      [URLS.apiHealthUrl]: {
        status: 200,
        body: { ready: true, database: true },
      },
      // botHealthUrl deliberately omitted — fakeFetch rejects for it.
    })

    const report = await checkPlatformHealth({ ...URLS, fetchFn })

    expect(report.bot).toEqual({ reachable: false })
    expect(report.worker.reachable).toBe(true)
    expect(report.api.reachable).toBe(true)
  })

  it('reports a not-ready process (a real 503) as reachable, distinct from unreachable', async () => {
    const fetchFn = fakeFetch({
      [URLS.botHealthUrl]: {
        status: 503,
        body: {
          gatewayConnected: false,
          model: { calls: 0, errors: 0, errorRate: 0 },
        },
      },
      [URLS.workerHealthUrl]: {
        status: 200,
        body: { ready: true, database: true, queueDepth: 0 },
      },
      [URLS.apiHealthUrl]: {
        status: 200,
        body: { ready: true, database: true },
      },
    })

    const report = await checkPlatformHealth({ ...URLS, fetchFn })

    expect(report.bot.reachable).toBe(true)
    expect(report.bot.status).toEqual({
      gatewayConnected: false,
      model: { calls: 0, errors: 0, errorRate: 0 },
    })
  })

  it('treats a timeout the same as an unreachable process, not a hang', async () => {
    // A real `fetch` rejects once its own `AbortSignal` fires — this fake
    // has to do the same to stand in for one; a fake that merely resolves
    // late (ignoring the signal entirely) would prove nothing about the
    // timeout path at all.
    const slowFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({}),
            } as Response),
          50
        )
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })) as typeof fetch

    const report = await checkPlatformHealth({
      ...URLS,
      fetchFn: slowFetch,
      timeoutMs: 5,
    })

    expect(report.bot).toEqual({ reachable: false })
    expect(report.worker).toEqual({ reachable: false })
    expect(report.api).toEqual({ reachable: false })
  })
})
