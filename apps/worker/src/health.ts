/**
 * JOB-5 — reports whether this process can actually work, not merely that
 * it is running: its database reachable (checked fresh on every call, the
 * same "cheap, real round trip" `apps/api`'s own `checkHealth` uses — not
 * cached from the moment it last changed) and how deep the queue currently
 * is (`@bloombot/db`'s `jobs.countQueuedJobs`) — an operator's "is anything
 * backing up" signal a bare process-is-running check cannot give.
 *
 * Plain `node:http`, no framework, bound to `127.0.0.1` only — the same
 * choice `apps/bot`'s own health server (`apps/bot/src/health.ts`) already
 * made for the same reason: this endpoint has no reason to be reachable
 * from outside the machine it runs on.
 */

import { createServer, type Server } from 'node:http'

import { jobs, type Database } from '@bloombot/db'

export interface WorkerHealthStatus {
  ready: boolean
  database: boolean
  queueDepth: number
}

/** A real round trip to the database, the same device `apps/api`'s `checkHealth` uses — `db.$client` is the underlying better-sqlite3 handle, so a closed or otherwise broken connection is caught here rather than on the next real claim. */
export function checkWorkerHealth(db: Database): WorkerHealthStatus {
  let database = true
  try {
    db.$client.prepare('select 1').get()
  } catch {
    database = false
  }
  // A queue depth read against an unreachable database would only throw
  // again — skip it rather than let a caught failure escape a second time.
  const queueDepth = database ? jobs.countQueuedJobs(db) : 0
  return { ready: database, database, queueDepth }
}

export interface HealthServer {
  /** Stops accepting new connections and resolves once the server is fully closed. */
  close: () => Promise<void>
}

/**
 * Start listening on `port`, bound to loopback only. `getStatus` is read
 * fresh on every request, not captured at startup — `index.ts` wires it to
 * report not-ready once a shutdown begins, the same as `apps/bot`'s own
 * `gatewayConnected` flag does for its health server.
 *
 * Resolves once the server is actually listening; rejects if it never
 * manages to bind — most often `EADDRINUSE`, the PLAT-4 "a second instance
 * of this process is already running" case, the same failure mode
 * `apps/bot`'s own `startHealthServer` reports.
 */
export function startHealthServer(
  port: number,
  getStatus: () => WorkerHealthStatus
): Promise<HealthServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_request, response) => {
      const status = getStatus()
      response.writeHead(status.ready ? 200 : 503, {
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
        new Error(`apps/worker: could not start the health server: ${reason}`)
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
