/**
 * apps/api — the Express control-plane API (API-1..6, PLAT-3, PLAT-4).
 *
 * Thin on purpose, the same shape `apps/bot`'s own module comment
 * describes for itself: every rule about who may do what lives in
 * `@bloombot/actions`/`@bloombot/auth`, and this file's own job is wiring
 * them to an HTTP server and a database connection, then listening. API-5:
 * this process opens no Discord gateway connection — it holds no
 * `discord.js` dependency at all (enforced by
 * `packages/discord/tests/no-vendor-sdk.test.ts`, which scans every
 * workspace package including this one) — anything it needs from Discord
 * later reaches it over REST with the same token `apps/bot` uses.
 */

import { createServer } from 'node:http'

import { createGoogleIdTokenVerifier } from '@bloombot/auth'
import { CONFIG } from '@bloombot/config'
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  type Database,
} from '@bloombot/db'
import { createLogger, type Logger } from '@bloombot/logger'

import { LoggingEmailSender } from './logging-email-sender.js'
import { buildApp } from './server.js'

const PROCESS_NAME = 'api'

async function main(): Promise<void> {
  // API-6 — refuses to start on an environment that does not validate:
  // touching `CONFIG` forces the whole zod schema to validate before
  // anything else runs, the same discipline `apps/bot`'s own `SURF-7`
  // holds itself to.
  const logsDir = CONFIG.LOGS_DIR
  const databasePath = CONFIG.DATABASE_PATH
  const port = CONFIG.API_PORT
  const publicAppUrl = CONFIG.PUBLIC_APP_URL

  const logger: Logger = createLogger(PROCESS_NAME, { logsDir })
  const db: Database = openDatabase(databasePath)
  runMigrations(db)

  const app = buildApp({
    db,
    logger,
    publicAppUrl,
    emailSender: new LoggingEmailSender(logger),
    buildSignInLink: (token) => `${publicAppUrl}/sign-in/${token}`,
    // Lazy by construction (PLAT-5) — nothing here fetches Google's keys;
    // that happens on the first `/auth/google` call, if one ever arrives.
    googleVerifier: createGoogleIdTokenVerifier(),
  })

  const server = createServer(app)

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === 'EADDRINUSE'
          ? `port ${port} is already in use — is another instance of this process already running? (PLAT-4)`
          : error.message
      reject(new Error(`apps/api: could not start the server: ${reason}`))
    })
    server.listen(port, () => {
      logger.info({ port }, 'apps/api: listening')
      resolve()
    })
  })

  // API-6 — closes the server and the database rather than exiting under
  // load; a second signal is a no-op rather than a second teardown racing
  // the first, the same guard `apps/bot`'s own `createShutdown` uses.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'apps/api: shutting down')
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    closeDatabase(db)
  }
  const onSignal = (signal: string) => {
    void shutdown(signal).then(() => process.exit(0))
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))
}

main().catch((error: unknown) => {
  // No logger may exist yet if `main` failed before `createLogger` ran (a
  // bad environment) — stderr is the only sink guaranteed to work, the same
  // fallback `apps/bot`'s own entry point uses.
  console.error('apps/api: failed to start', error)
  process.exit(1)
})
