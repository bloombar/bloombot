/**
 * SURF-7's health endpoint — the one piece of `apps/bot` with no discord.js
 * in it at all, so it is cheap to test directly rather than leave inside
 * this app's otherwise-untested wiring. No network beyond loopback.
 */

import { Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

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

  return { server: await startHealthServer(port, isGatewayConnected), port }
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

  // Finding 8 — `listen(port)` with no host binds every interface
  // (`0.0.0.0`); this endpoint has no reason to be reachable from outside
  // the machine it runs on. Spies on the real `listen` call itself (still
  // calling through to it, so the server still actually starts) rather than
  // trying to prove a negative by connecting from a non-loopback address —
  // which "no network beyond loopback" rules out doing anyway.
  it('binds only the loopback interface, not every interface', async () => {
    const listenSpy = vi.spyOn(Server.prototype, 'listen')
    const { server: started, port } = await startOnFreePort(() => true)
    server = started

    const call = listenSpy.mock.calls.find((args) => args[0] === port)
    expect(call?.[1]).toBe('127.0.0.1')
    listenSpy.mockRestore()
  })

  // Finding 8 — a bind failure (most often `EADDRINUSE`, the PLAT-4 "a
  // second instance of this process is already running" case) used to have
  // no `'error'` listener at all, so it escaped as an uncaught exception
  // rather than a rejection `main().catch` could handle the same way it
  // handles a bad environment. Binding the same port twice reproduces
  // exactly that failure.
  it('rejects clearly, rather than throwing an uncaught exception, when the port is already in use', async () => {
    const { server: started, port } = await startOnFreePort(() => true)
    server = started

    await expect(startHealthServer(port, () => true)).rejects.toThrow(
      /already in use/
    )
  })
})
