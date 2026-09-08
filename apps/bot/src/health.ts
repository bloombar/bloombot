/**
 * SURF-7/COST-5 — the process's own health endpoint.
 *
 * It reports whether the gateway is currently connected, so an operator (or,
 * once OPS-2 lands for this process, pm2) can tell "the process is running"
 * from "the process is actually receiving Discord events" apart — a process
 * that is up but stuck reconnecting looks identical to a healthy one from
 * the outside without this. COST-5 adds one more number: the model
 * provider's own running error rate (`@bloombot/core`'s
 * `createCountingModelClient`), so a provider outage is visible here too,
 * not only in the logs — the same "noticed before a student reports it"
 * text COST-5 itself uses.
 *
 * It deliberately reports nothing else: not the database, not any
 * per-request state. Every one of those already degrades to a logged error
 * and a reply rather than taking the process down (CORE-5), so there is
 * nothing about them a process-level health check could usefully report
 * that the logs do not already say better.
 *
 * Plain `node:http`, no framework — this is the one thing this process
 * exposes over HTTP, and it does not need one.
 */

import { createServer, type Server } from 'node:http'

import type { ModelCallStats } from '@bloombot/core'

export interface HealthServer {
  /** Stops accepting new connections and resolves once the server is fully closed. */
  close: () => Promise<void>
}

/** What `startHealthServer`'s own response body reports — read fresh on every request, never cached. */
export interface BotHealthStatus {
  gatewayConnected: boolean
  model: ModelCallStats
}

/**
 * Start listening on `port`, bound to `127.0.0.1` only (finding 8 of this
 * slice's rework — `listen(port)` with no host binds every interface, so an
 * unfirewalled host would let anyone poll this process's connection state;
 * this endpoint has no reason to be reachable from outside the machine it
 * runs on). Every request gets the same shape of response: `200` once the
 * gateway is connected, `503` before that (or after a shutdown begins) —
 * `isGatewayConnected`/`getModelStats` are both read fresh on every request
 * rather than captured once, so the answer changes the moment either's own
 * state does.
 *
 * Resolves once the server is actually listening; rejects if it never
 * manages to bind — most often `EADDRINUSE`, the PLAT-4 "a second instance
 * of this process is already running" case. Finding 8: with no listener on
 * the server's own `'error'` event, that failure was an uncaught exception
 * escaping `main().catch` entirely rather than reaching the same
 * clear-refusal path `requireEnv` gives a bad environment — rejecting here
 * routes it through exactly that path instead.
 */
export function startHealthServer(
  port: number,
  isGatewayConnected: () => boolean,
  getModelStats: () => ModelCallStats
): Promise<HealthServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_request, response) => {
      const connected = isGatewayConnected()
      const status: BotHealthStatus = {
        gatewayConnected: connected,
        model: getModelStats(),
      }
      response.writeHead(connected ? 200 : 503, {
        'Content-Type': 'application/json',
      })
      response.end(JSON.stringify(status))
    })

    server.once('error', (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === 'EADDRINUSE'
          ? `port ${port} is already in use — is another instance of this process already running? (PLAT-4)`
          : error.message
      reject(
        new Error(`apps/bot: could not start the health server: ${reason}`)
      )
    })

    server.listen(port, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve()
            )
          }),
      })
    })
  })
}
