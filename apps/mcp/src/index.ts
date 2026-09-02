/**
 * apps/mcp — the MCP server (MCP-1..5, PLAT-3, PLAT-4).
 *
 * Thin on purpose, the same shape `apps/api`'s and `apps/bot`'s own module
 * comments describe for themselves: `server.ts` carries every rule about
 * what an assistant may reach and how a destructive call is confirmed, and
 * this file's own job is wiring it to a database connection and an HTTP
 * listener, then shutting down cleanly.
 */

import { createServer } from 'node:http'

import { createPlatformRegistry } from '@bloombot/actions'
import { CONFIG, loadDotEnv } from '@bloombot/config'
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  type Database,
} from '@bloombot/db'
import { createLogger, type Logger } from '@bloombot/logger'

import { buildApp } from './server.js'

const PROCESS_NAME = 'mcp'

async function main(): Promise<void> {
  // CFG-5: credentials live in `.env`; load it before anything reads CONFIG,
  // which validates the whole environment on first access.
  loadDotEnv()

  // Refuses to start on an environment that does not validate — the same
  // "touch CONFIG before building anything" discipline `apps/api`/`apps/bot`
  // already hold themselves to.
  const logsDir = CONFIG.LOGS_DIR
  const databasePath = CONFIG.DATABASE_PATH
  const port = CONFIG.MCP_PORT
  // FILE-1..5 — the same directory `apps/api`/`apps/worker` already share
  // for a course attachment's own bytes (D-2: one filesystem). No tool in
  // this slice's own allowlist (`tool-surface.ts`) actually reaches
  // `courseAttachments.attach`, but `createPlatformRegistry` still builds
  // the action (every process registers the whole catalog; the allowlist
  // is what decides what is reachable, not what is registered — MCP-2's
  // own module comment).
  const attachmentStorageDir = CONFIG.ATTACHMENT_STORAGE_DIR

  const logger: Logger = createLogger(PROCESS_NAME, { logsDir })
  const db: Database = openDatabase(databasePath)
  runMigrations(db)

  const registry = createPlatformRegistry({ attachmentStorageDir })
  const app = buildApp({ db, logger, registry })

  const server = createServer(app)

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === 'EADDRINUSE'
          ? `port ${port} is already in use — is another instance of this process already running? (PLAT-4)`
          : error.message
      reject(new Error(`apps/mcp: could not start the server: ${reason}`))
    })
    // Bound to `127.0.0.1` only, the same reason `apps/api`'s own module
    // comment gives its equally sensitive endpoint: nothing here needs to
    // be reachable from outside the machine it runs on, and PLAT-4 puts
    // nginx in front of whatever does need to reach it remotely.
    server.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'apps/mcp: listening')
      resolve()
    })
  })

  // Closes the server and the database rather than exiting under load; a
  // second signal is a no-op rather than a second teardown racing the
  // first, the same guard `apps/api`'s own entry point uses.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'apps/mcp: shutting down')
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    closeDatabase(db)
  }
  const onSignal = (signal: string) => {
    shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(
          { err: error, signal },
          'apps/mcp: failed to shut down cleanly'
        )
        process.exit(1)
      }
    )
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))
}

main().catch((error: unknown) => {
  // No logger may exist yet if `main` failed before `createLogger` ran (a
  // bad environment) — stderr is the only sink guaranteed to work, the same
  // fallback every other process's own entry point uses.
  console.error('apps/mcp: failed to start', error)
  process.exit(1)
})
