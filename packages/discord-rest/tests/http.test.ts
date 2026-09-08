/**
 * `postForm`/`getJson` (`http.ts`) — cheap-fix 6 of the TEN-4..6 rework: the
 * timeout and transport-failure branches `runFetch` classifies
 * `DiscordTransportError` into, exercised directly rather than only through
 * `client.ts`'s own tests (which never hit either — `FakeDiscordServer`
 * always answers immediately). The same loopback-server shape
 * `packages/openai/tests/http.test.ts` uses for its own timeout test; no
 * test here reaches the real network.
 */

import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { DiscordTransportError, getJson } from '../src/http.js'

/** Start `server` on an OS-assigned loopback port and resolve its base URL. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('test server did not report a port')
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('runFetch (cheap-fix 6 of the TEN-4..6 rework): timeout', () => {
  let server: Server

  afterEach(async () => {
    await close(server)
  })

  it('classifies its own abort as a timeout — DiscordTransportError with timedOut: true — not a generic transport failure', async () => {
    server = createServer(() => {
      // Never responds: `fetch` is left hanging until this file's own
      // AbortController fires.
    })
    const baseUrl = await listen(server)

    const start = Date.now()
    let caught: DiscordTransportError | undefined
    try {
      await getJson(`${baseUrl}/users/@me/guilds`, 'Bearer token', {
        fetchFn: fetch,
        timeoutMs: 200,
      })
    } catch (error) {
      caught = error as DiscordTransportError
    }
    const elapsed = Date.now() - start

    expect(caught).toBeInstanceOf(DiscordTransportError)
    expect(caught?.timedOut).toBe(true)
    expect(caught?.message).toMatch(/timed out after 200ms/)
    // Bounded near `timeoutMs`, not left to whatever the runtime's own
    // fetch would otherwise wait for.
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('runFetch (cheap-fix 6 of the TEN-4..6 rework): a genuine transport failure', () => {
  it('classifies a rejection that is not its own abort as DiscordTransportError with timedOut: false, carrying the original error as cause', async () => {
    const transportFailure = new Error('connect ECONNREFUSED 127.0.0.1:1')
    const rejectingFetch: typeof fetch = () => Promise.reject(transportFailure)

    let caught: DiscordTransportError | undefined
    try {
      await getJson('http://127.0.0.1:1/users/@me/guilds', 'Bearer token', {
        fetchFn: rejectingFetch,
        timeoutMs: 10_000,
      })
    } catch (error) {
      caught = error as DiscordTransportError
    }

    expect(caught).toBeInstanceOf(DiscordTransportError)
    expect(caught?.timedOut).toBe(false)
    expect(caught?.message).toMatch(/failed before a response arrived/)
    expect(caught?.cause).toBe(transportFailure)
  })
})
