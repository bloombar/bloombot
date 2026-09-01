/**
 * SURF-7 — the process's own health endpoint.
 *
 * It reports exactly one thing: whether the gateway is currently connected,
 * so an operator (or, once OPS-2 lands for this process, pm2) can tell
 * "the process is running" from "the process is actually receiving Discord
 * events" apart — a process that is up but stuck reconnecting looks
 * identical to a healthy one from the outside without this.
 *
 * It deliberately reports nothing else: not the database, not the OpenAI
 * adapter, not any per-request state. Every one of those already degrades to
 * a logged error and a reply rather than taking the process down (CORE-5),
 * so there is nothing about them a process-level health check could usefully
 * report that the logs do not already say better.
 *
 * Plain `node:http`, no framework — this is the one thing this process
 * exposes over HTTP, and it does not need one.
 */

import { createServer, type Server } from 'node:http'

export interface HealthServer {
  /** Stops accepting new connections and resolves once the server is fully closed. */
  close: () => Promise<void>
}

/**
 * Start listening on `port`. Every request gets the same response: `200`
 * with `{ "gatewayConnected": true }` once the gateway has connected, `503`
 * with `{ "gatewayConnected": false }` before that (or after a shutdown
 * begins) — `isGatewayConnected` is read fresh on every request rather than
 * captured once, so the answer changes the moment the gateway's own state
 * does.
 */
export function startHealthServer(
  port: number,
  isGatewayConnected: () => boolean
): HealthServer {
  const server: Server = createServer((_request, response) => {
    const connected = isGatewayConnected()
    response.writeHead(connected ? 200 : 503, {
      'Content-Type': 'application/json',
    })
    response.end(JSON.stringify({ gatewayConnected: connected }))
  })
  server.listen(port)

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
