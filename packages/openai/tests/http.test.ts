/**
 * `postJson` (`http.ts`) — findings 2 and 7 of the MDL-1 rework, exercised
 * directly against a raw `node:http` server rather than `FakeOpenAiServer`
 * (`fake-openai-server.ts`'s own `delayMs` only delays *before* writing
 * headers, which cannot reproduce finding 2's "headers arrived, body
 * stalled"). Loopback only (`127.0.0.1:0`, MDL-7) — no real network.
 */

import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { postJson } from '../src/http.js'

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

/** Bounds the stalling-body test below, well under undici's own multi-minute default — so a regression of finding 2's fix fails this test instead of hanging the whole suite. */
const THIS_TESTS_OWN_TIMEOUT_MS = 5000

describe('postJson (finding 2 of the MDL-1 rework): the timeout stays armed across the body read', () => {
  let server: Server

  afterEach(async () => {
    await close(server)
  })

  it(
    "abandons a request whose body stalls after headers arrive, within roughly timeoutMs — not the runtime fetch's own multi-minute default",
    async () => {
      server = createServer((_req, res) => {
        // Headers (and a fragment of a body) go out, then silence —
        // `res.end()` is never called. Before finding 2's fix, `postJson`
        // cleared its own abort timer the moment `fetch` resolved these
        // headers, so nothing here bounded the `response.text()` that
        // follows; the request would hang until the runtime's own fetch
        // implementation gave up on its own (undici's default is five
        // minutes).
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"output": [')
      })
      const baseUrl = await listen(server)

      const start = Date.now()
      await expect(
        postJson(
          '/responses',
          { question: 'stalls after headers' },
          { fetchFn: fetch, baseUrl, apiKey: 'test-key', timeoutMs: 200 }
        )
      ).rejects.toThrow(/did not complete within/)
      const elapsed = Date.now() - start

      // Bounded near `timeoutMs` (200ms), nowhere close to undici's
      // multi-minute default — generous enough not to flake on a loaded
      // machine, tight enough that a regression back to "the timer only
      // guards the headers" fails this assertion well within the test's
      // own timeout below, rather than hanging the whole suite.
      expect(elapsed).toBeLessThan(2000)

      // This test's own bound (below): if the fix regresses and the abort
      // silently stops guarding the body read, this fails on a timeout
      // rather than hanging `npm test` for undici's five minutes.
    },
    THIS_TESTS_OWN_TIMEOUT_MS
  )
})

describe('postJson (finding 7 of the MDL-1 rework): a trailing slash on baseUrl does not break the path', () => {
  let server: Server
  let baseUrl: string
  let receivedPath: string | undefined

  afterEach(async () => {
    await close(server)
  })

  async function startEchoServer(): Promise<void> {
    receivedPath = undefined
    server = createServer((req, res) => {
      receivedPath = req.url
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    baseUrl = await listen(server)
  }

  it('reaches the right path when baseUrl has no trailing slash', async () => {
    await startEchoServer()

    const result = await postJson(
      '/responses',
      {},
      { fetchFn: fetch, baseUrl, apiKey: 'test-key', timeoutMs: 1000 }
    )

    expect(result.ok).toBe(true)
    expect(receivedPath).toBe('/responses')
  })

  it('reaches the right path when baseUrl has a trailing slash — the form OPENAI_BASE_URL=https://api.openai.com/v1/ writes', async () => {
    await startEchoServer()

    const result = await postJson(
      '/responses',
      {},
      {
        fetchFn: fetch,
        baseUrl: `${baseUrl}/`,
        apiKey: 'test-key',
        timeoutMs: 1000,
      }
    )

    expect(result.ok).toBe(true)
    // Without the fix this lands on `//responses`, a different path this
    // fake would 404 rather than answer — the assertion below is the one
    // that actually distinguishes the two.
    expect(receivedPath).toBe('/responses')
  })
})
