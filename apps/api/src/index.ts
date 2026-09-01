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
import { createDiscordRestClient } from '@bloombot/discord-rest'
import { createLogger, type Logger } from '@bloombot/logger'

import { buildEmailSender } from './logging-email-sender.js'
import { buildApp } from './server.js'

const PROCESS_NAME = 'api'

/**
 * TEN-4 — credentials `@bloombot/config`'s schema does not cover, the same
 * CFG-5 convention `apps/bot`'s own `requireEnv` already holds itself to:
 * read directly here, at startup, rather than widening the shared schema
 * for this slice, and checked explicitly so a missing one fails loudly
 * before this process ever accepts a request instead of the first time an
 * install is attempted.
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`apps/api: ${name} must be set (see env.example)`)
  }
  return value
}

async function main(): Promise<void> {
  // API-6 — refuses to start on an environment that does not validate:
  // touching `CONFIG` forces the whole zod schema to validate before
  // anything else runs, the same discipline `apps/bot`'s own `SURF-7`
  // holds itself to.
  const logsDir = CONFIG.LOGS_DIR
  const databasePath = CONFIG.DATABASE_PATH
  const port = CONFIG.API_PORT
  const publicAppUrl = CONFIG.PUBLIC_APP_URL
  const nodeEnv = CONFIG.NODE_ENV
  // FILE-1..5 — read once here, alongside every other `CONFIG` value this
  // process reads at startup, and threaded to `buildApp` rather than left
  // for `createPlatformRegistry`'s own default to read `CONFIG` a second
  // time.
  const attachmentStorageDir = CONFIG.ATTACHMENT_STORAGE_DIR

  // TEN-4 — the same fail-loudly-at-startup discipline `apps/bot`'s own
  // `BOT_TOKEN`/`OPENAI_API_KEY` checks hold themselves to, applied to the
  // three Discord credentials the install flow needs. `BOT_APP_ID` doubles
  // as the OAuth "client id" — Discord's own client id and application id
  // are the same value.
  const discordClientId = requireEnv('BOT_APP_ID')
  const discordBotToken = requireEnv('BOT_TOKEN')
  const discordClientSecret = requireEnv('DISCORD_CLIENT_SECRET')
  // Not a credential (it is a bot permission bitmask, not a secret) and not
  // every deployment sets one — omitted from the authorization URL entirely
  // when unset (`routes/discord-servers.ts`), rather than defaulted here.
  const discordPermissions = process.env['BOT_PERMISSIONS']
  // Read once, here, alongside every other `CONFIG` value this process
  // reads at startup — `routes/discord-servers.ts` takes it as an explicit
  // dependency rather than reaching for `CONFIG` itself mid-request.
  const discordOauthBase = CONFIG.DISCORD_OAUTH_BASE

  const logger: Logger = createLogger(PROCESS_NAME, { logsDir })
  const db: Database = openDatabase(databasePath)
  runMigrations(db)

  const app = buildApp({
    db,
    logger,
    publicAppUrl,
    attachmentStorageDir,
    // Must-fix 1 of the API-1..6 rework: refuses outright rather than
    // silently logging sign-in links in production — see
    // `logging-email-sender.ts`.
    emailSender: buildEmailSender(nodeEnv, process.env['MAIL_FILE'], logger),
    buildSignInLink: (token) => `${publicAppUrl}/sign-in/${token}`,
    // Lazy by construction (PLAT-5) — nothing here fetches Google's keys;
    // that happens on the first `/auth/google` call, if one ever arrives.
    googleVerifier: createGoogleIdTokenVerifier(),
    // TEN-4 — real Discord REST calls, base URLs from `CONFIG` (QA-2), never
    // this file.
    discordRestClient: createDiscordRestClient({
      clientId: discordClientId,
      clientSecret: discordClientSecret,
    }),
    discordClientId,
    discordBotToken,
    ...(discordPermissions ? { discordPermissions } : {}),
    // Must exactly match a redirect URI registered with the Discord
    // application — the web shell's own callback page (next slice), read
    // off `code`/`state`/`guild_id` and posted here.
    discordRedirectUri: `${publicAppUrl}/discord/callback`,
    discordOauthBase,
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
    // Bound to `127.0.0.1` only (cheap-fix 7 of the API-1..6 rework):
    // `listen(port)` with no host binds every interface, and PLAT-4 puts
    // nginx in front of this process for TLS termination — on an
    // unfirewalled host, listening on every interface would let this API
    // answer directly, outside that termination. The same choice
    // `apps/bot`'s own health server already made for its far less
    // sensitive endpoint (D-19's finding 8); no reason found to make the
    // interface configurable instead.
    server.listen(port, '127.0.0.1', () => {
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
    // Cheap-fix 6 of the API-1..6 rework: the previous version had no
    // rejection handler here, so a failing `shutdown` (e.g. `server.close`
    // erroring) skipped both `closeDatabase(db)` and the clean exit,
    // leaving an unhandled rejection with the SQLite handle still open. A
    // failed shutdown now still exits — non-zero, so an operator (or pm2,
    // PLAT-4) can tell a clean stop from a botched one.
    shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(
          { err: error, signal },
          'apps/api: failed to shut down cleanly'
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
  // fallback `apps/bot`'s own entry point uses.
  console.error('apps/api: failed to start', error)
  process.exit(1)
})
