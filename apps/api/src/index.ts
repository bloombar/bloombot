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
 *
 * WEB-10: this process also builds the model client, admission gate and
 * pricing table `routes/chat.ts` calls `@bloombot/core#answerQuestion`
 * with — the same three seams `apps/bot`'s own `main()` builds for
 * `handleMention`, because the web chat surface answers through the exact
 * same pipeline, just a different adapter.
 */

import { createServer } from 'node:http'

import { createGoogleIdTokenVerifier } from '@bloombot/auth'
import { CONFIG, getModelPricingTable, loadDotEnv } from '@bloombot/config'
import type { ModelClient } from '@bloombot/core'
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  type Database,
} from '@bloombot/db'
import { createDiscordRestClient } from '@bloombot/discord-rest'
import { createAdmissionGate } from '@bloombot/jobs'
import { createLogger, type Logger } from '@bloombot/logger'
import { createOpenAiModelClient } from '@bloombot/openai'

import { buildEmailSender } from './logging-email-sender.js'
import { buildApp } from './server.js'

const PROCESS_NAME = 'api'

/**
 * WEB-10 — `routes/chat.ts` needs a `ModelClient` no matter what, but
 * `OPENAI_API_KEY` being unset must not stop this whole process from
 * starting: `docs/RUNNING_LOCALLY.md`'s own "the API and the panel still
 * come up" promise (today scoped to `BOT_TOKEN`/the Discord credentials)
 * would otherwise quietly grow a second, undocumented way to fail a
 * checkout that only wants to browse the panel. `answerQuestion`
 * (`packages/core/src/answer.ts`) already has a defined, ordinary outcome
 * for a model call that throws — `failed-with-apology` — so a stand-in
 * whose `ask()` always rejects degrades chat to that apology rather than
 * refusing to boot; `main()` logs once, at startup, so an operator who
 * meant to configure this finds out from the log, not from a student's
 * refusal (the same "found out from logs, not an invoice" shape
 * `packages/core/src/answer.ts`'s own `NO_PRICING_CONFIGURED` comment
 * already uses for the identical class of gap).
 */
function createUnconfiguredModelClient(): ModelClient {
  return {
    ask: () =>
      Promise.reject(new Error('apps/api: OPENAI_API_KEY is not configured')),
  }
}

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

/**
 * ENRL-12 — `JOIN_LINK_ENCRYPTION_KEY`, base64-encoded 32 bytes for
 * AES-256-GCM. Optional, unlike `requireEnv` above: an unset key is a
 * supported deployment, not a startup failure — `docs/SPEC.md`'s own text,
 * "a deployment with no key configured keeps today's behaviour exactly."
 * A *set but malformed* value is different: silently ignoring it would
 * leave an operator believing reveal works when it never will, so this
 * fails loudly at startup instead, the same "a bad environment fails
 * immediately" discipline `packages/config/src/env.ts`'s own module comment
 * holds the schema-validated half of the environment to — this one just
 * cannot go through that schema, since it is a credential (CFG-5).
 */
function readJoinLinkEncryptionKey(): Buffer | undefined {
  const value = process.env['JOIN_LINK_ENCRYPTION_KEY']
  if (!value) return undefined
  let key: Buffer
  try {
    key = Buffer.from(value, 'base64')
  } catch {
    throw new Error(
      'apps/api: JOIN_LINK_ENCRYPTION_KEY is set but is not valid base64 (see env.example)'
    )
  }
  if (key.byteLength !== 32) {
    throw new Error(
      `apps/api: JOIN_LINK_ENCRYPTION_KEY must decode to 32 bytes for AES-256-GCM, got ${key.byteLength} (see env.example)`
    )
  }
  return key
}

async function main(): Promise<void> {
  // CFG-5: credentials live in `.env`; load it before anything reads CONFIG,
  // which validates the whole environment on first access.
  loadDotEnv()

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
  // WEB-10 — JOB-4's own admission bound and COST-1/COST-6's own rate
  // table, read the same "once here, threaded through" way `apps/bot`'s own
  // `main()` reads them for `handleMention`; `routes/chat.ts`'s own
  // `answerQuestion` call needs both for exactly the same reasons that
  // file's module comment already gives.
  const admissionLimit = CONFIG.MODEL_ADMISSION_LIMIT
  const admissionWaitMs = CONFIG.MODEL_ADMISSION_WAIT_MS
  // ADMIN-4/COST-5 — the three processes' own loopback health endpoints,
  // read once here alongside every other `CONFIG` value this process
  // reads at startup (`docs/DECISIONS.md` D-33's own accounting of who has
  // to know these three ports — this router's own phase).
  const botHealthUrl = `http://127.0.0.1:${CONFIG.BOT_HEALTH_PORT}/health`
  const workerHealthUrl = `http://127.0.0.1:${CONFIG.WORKER_HEALTH_PORT}/health`
  const apiHealthUrl = `http://127.0.0.1:${port}/health`
  // AUTH-5 — the real mail transport's non-secret configuration, through
  // `CONFIG` like everything else above; `MAIL_SMTP_USER`/`MAIL_SMTP_PASSWORD`
  // are read directly just below, alongside the Discord/OpenAI credentials,
  // for the same CFG-5 reason those are.
  const smtp = {
    host: CONFIG.MAIL_SMTP_HOST,
    port: CONFIG.MAIL_SMTP_PORT,
    from: CONFIG.MAIL_FROM,
    user: process.env['MAIL_SMTP_USER'],
    password: process.env['MAIL_SMTP_PASSWORD'],
  }

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
  // WEB-10 — not `requireEnv`, deliberately: see `createUnconfiguredModelClient`'s
  // own doc comment just above for why a missing key degrades chat rather
  // than stopping this whole process from starting.
  const openaiApiKey = process.env['OPENAI_API_KEY']
  // ENRL-12 — read once here, alongside every other credential this process
  // reads at startup; `readJoinLinkEncryptionKey`'s own doc comment has the
  // "optional, but fails loudly if malformed" reasoning.
  const joinLinkEncryptionKey = readJoinLinkEncryptionKey()

  const logger: Logger = createLogger(PROCESS_NAME, { logsDir })
  const db: Database = openDatabase(databasePath)
  runMigrations(db)

  // WEB-10 — the same model client, admission gate and pricing table
  // `apps/bot`'s own `main()` builds for `handleMention`, built here for
  // `routes/chat.ts`'s own `answerQuestion` call: two surfaces, the same
  // brain, each with its own configured seam (this file's own module
  // comment, and `packages/core/src/answer.ts`'s "the surface is a
  // different adapter, not a different brain"). Not wrapped in
  // `createCountingModelClient` the way `apps/bot` wraps its own: that
  // wrapper's whole purpose is feeding `apps/bot`'s own health endpoint a
  // running call count, which this process has no equivalent of — nothing
  // here reads the stats a counting client would report.
  if (!openaiApiKey) {
    // Rework finding — this used to log from inside `ask()`, so it fired
    // once *per chat request* rather than once at startup, exactly the
    // opposite of what this file's own module comment (and `docs/DECISIONS.md`)
    // already claimed it did. Logged here, once, at the only place that
    // actually knows the key is missing before a single request has
    // arrived.
    logger.warn(
      {},
      'apps/api: OPENAI_API_KEY is not set — the web chat surface will apologize to every question until it is configured'
    )
  }
  const model = openaiApiKey
    ? createOpenAiModelClient({ apiKey: openaiApiKey, logger })
    : createUnconfiguredModelClient()
  const admission = createAdmissionGate({
    limit: admissionLimit,
    waitMs: admissionWaitMs,
  })
  const pricing = getModelPricingTable(CONFIG.MODEL_PRICING_JSON)

  const app = buildApp({
    db,
    logger,
    publicAppUrl,
    attachmentStorageDir,
    ...(joinLinkEncryptionKey ? { joinLinkEncryptionKey } : {}),
    // Must-fix 1 of the API-1..6 rework: refuses outright rather than
    // silently logging sign-in links in production — see
    // `logging-email-sender.ts`.
    emailSender: buildEmailSender(
      nodeEnv,
      process.env['MAIL_FILE'],
      smtp,
      logger
    ),
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
    model,
    admission,
    pricing,
    botHealthUrl,
    workerHealthUrl,
    apiHealthUrl,
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
