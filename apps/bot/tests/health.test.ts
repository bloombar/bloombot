/**
 * SURF-7's health endpoint — the one piece of `apps/bot` with no discord.js
 * in it at all, so it is cheap to test directly rather than leave inside
 * this app's otherwise-untested wiring. No network beyond loopback.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { startHealthServer, type HealthServer } from '../src/health.js'

let server: HealthServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

/** Finds a free loopback port the same way the fake OpenAI/Discord test servers elsewhere in the repo do — `listen(0)` and read back the assigned port. */
async function startOnFreePort(
  isGatewayConnected: () => boolean
): Promise<{ server: HealthServer; port: number }> {
  // node:http assigns the port synchronously inside `listen`, but there is
  // no public accessor on the `HealthServer` port itself — so the test binds
  // its own probe server first (port 0), grabs the port, closes it, and
  // trusts the OS not to hand it straight back out from under it within the
  // same synchronous tick. Simpler and just as reliable in practice: ask
  // `startHealthServer` for a fixed high port unlikely to collide, retried
  // on failure would be over-engineering a five-line test suite.
  const { createServer } = await import('node:http')
  const probe = createServer()
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        throw new Error('startOnFreePort: could not read the assigned port')
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  return { server: startHealthServer(port, isGatewayConnected), port }
}

describe('startHealthServer (SURF-7)', () => {
  it('reports 503 and gatewayConnected: false before the gateway has connected', async () => {
    const { server: started, port } = await startOnFreePort(() => false)
    server = started

    const response = await fetch(`http://127.0.0.1:${port}`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ gatewayConnected: false })
  })

  it('reports 200 and gatewayConnected: true once the gateway is connected', async () => {
    let connected = false
    const { server: started, port } = await startOnFreePort(() => connected)
    server = started

    connected = true // flips after the server started — read fresh per request, not cached at startup
    const response = await fetch(`http://127.0.0.1:${port}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ gatewayConnected: true })
  })

  it('stops accepting connections once closed', async () => {
    const { server: started, port } = await startOnFreePort(() => true)
    server = started
    await started.close()
    server = undefined

    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toBeTruthy()
  })
})
