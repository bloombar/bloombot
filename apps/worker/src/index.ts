/**
 * apps/worker — the background job runner (JOB-1..5, PLAT-3, PLAT-4).
 *
 * Thin on purpose, the same shape `apps/bot`'s and `apps/api`'s own module
 * comments describe for themselves: `@bloombot/jobs`'s `runNextJob` holds
 * the claim/run/retry logic, and this file's own job is wiring it to a
 * database connection, a health endpoint, and a loop, then shutting down
 * cleanly. Single-instance by design (PLAT-4), the same "a second copy is
 * an operator error, not redundancy" reasoning `apps/bot`'s own module
 * comment states outright — enforced the same way every process in this
 * platform enforces it: a second instance fails to bind this process's own
 * health port.
 *
 * SRV-6..8 — `discordServers.scaffold` (`handlers/discord-scaffold.ts`) was
 * this process's first real handler: `HandlerRegistry` no longer starts
 * empty. It is registered here, not built into `@bloombot/jobs` itself,
 * the same "handlers are registered by whoever wires a process up, never
 * by the registry's own package" division `registry.ts`'s own module
 * comment describes — ROST-9..12's `roster.import`
 * (`handlers/roster-import.ts`) registers alongside it the same way, and
 * FILE-1..3's `courseAttachments.attach`/`.detach`
 * (`handlers/course-attachments.ts`) do too, this slice.
 */

import { randomUUID } from 'node:crypto'

import { CONFIG, loadDotEnv } from '@bloombot/config'
import {
  closeDatabase,
  createFilesystemAttachmentStorage,
  openDatabase,
  runMigrations,
  type Database,
} from '@bloombot/db'
import { createDiscordRestClient } from '@bloombot/discord-rest'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import { createLogger, type Logger } from '@bloombot/logger'
import type { FilesHttpOptions } from '@bloombot/openai'

import {
  createAttachCourseAttachmentHandler,
  createDetachCourseAttachmentHandler,
  ATTACH_COURSE_ATTACHMENT_JOB_KIND,
  DETACH_COURSE_ATTACHMENT_JOB_KIND,
} from './handlers/course-attachments.js'
import {
  createDiscordScaffoldHandler,
  DISCORD_SCAFFOLD_JOB_KIND,
} from './handlers/discord-scaffold.js'
import {
  createRosterImportHandler,
  ROSTER_IMPORT_JOB_KIND,
} from './handlers/roster-import.js'
import { startHealthServer, workerHealthStatus } from './health.js'
import { createWorkerLoop, runLoopOrExit } from './loop.js'
import { createShutdown, InFlightJob } from './shutdown.js'

const PROCESS_NAME = 'worker'

/**
 * SRV-6 — credentials `@bloombot/config`'s schema does not cover, the same
 * CFG-5 convention `apps/bot`'s and `apps/api`'s own `requireEnv` already
 * hold themselves to: read directly here, at startup, rather than widening
 * the shared schema for this slice.
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`apps/worker: ${name} must be set (see env.example)`)
  }
  return value
}

async function main(): Promise<void> {
  // CFG-5: credentials live in `.env`; load it before anything reads CONFIG,
  // which validates the whole environment on first access.
  loadDotEnv()

  // JOB-5 — refuses to start on an environment that does not validate,
  // the same "touch CONFIG before building anything" discipline
  // `apps/bot`/`apps/api`'s own `main()` already holds itself to.
  const logsDir = CONFIG.LOGS_DIR
  const databasePath = CONFIG.DATABASE_PATH
  const healthPort = CONFIG.WORKER_HEALTH_PORT
  const leaseMs = CONFIG.JOB_CLAIM_LEASE_MS
  const pollIntervalMs = CONFIG.JOB_POLL_INTERVAL_MS
  const handlerTimeoutMs = CONFIG.JOB_HANDLER_TIMEOUT_MS
  // Rework finding 4 — the bound on attempts is `job.maxAttempts` on the
  // row itself (`repos/jobs.ts#NewJob.maxAttempts`, enforced in
  // `runner.ts`), not part of this policy; see `retry.ts`'s own module
  // comment for why the earlier `maxAttempts` field here was deleted rather
  // than wired up.
  const retryPolicy: RetryPolicy = {
    baseDelayMs: CONFIG.JOB_RETRY_BASE_DELAY_MS,
    backoffFactor: CONFIG.JOB_RETRY_BACKOFF_FACTOR,
  }
  // SRV-6 — this process reaches Discord over REST with the same bot token
  // `apps/bot`'s gateway connection uses (`apps/bot`'s own module comment),
  // never a gateway connection of its own. `BOT_TOKEN` is the only one of
  // `apps/api`'s three install-flow credentials this process actually needs:
  // the scaffold handler's own guild-management calls are bot-token
  // authenticated, never OAuth (this file's own module comment). Finding 7
  // of the SRV-6..8 rework — `BOT_APP_ID`/`DISCORD_CLIENT_SECRET` used to be
  // `requireEnv`'d anyway, for no reason beyond `createDiscordRestClient`'s
  // own signature wanting *some* `clientId`/`clientSecret` — so a deployment
  // that gave this process only `BOT_TOKEN` crash-looped on two secrets it
  // had no use for, and needlessly widened where the OAuth client secret has
  // to be distributed just to run the worker. Optional here, defaulting to
  // `''`: `exchangeAuthorizationCode`, the one `DiscordRestClient` call that
  // actually reads them, is never called from this process.
  const discordClientId = process.env['BOT_APP_ID'] ?? ''
  const discordBotToken = requireEnv('BOT_TOKEN')
  const discordClientSecret = process.env['DISCORD_CLIENT_SECRET'] ?? ''
  // FILE-1..3 — this process's own OpenAI credential, the same one
  // `apps/bot`'s own `createOpenAiModelClient` reads (CFG-5: a credential
  // `@bloombot/config`'s schema does not cover, checked explicitly here).
  const openaiApiKey = requireEnv('OPENAI_API_KEY')
  const openaiHttpOptions: FilesHttpOptions = {
    fetchFn: fetch,
    baseUrl: CONFIG.OPENAI_BASE_URL,
    apiKey: openaiApiKey,
    // Rework finding 10 — this used to equal `handlerTimeoutMs` itself, the
    // whole handler's own budget, not just one request's. `createAttachCourseAttachmentHandler`
    // makes up to three sequential provider calls (upload, create-vector-store,
    // attach) — with no smaller bound, one slow call could consume the
    // entire handler budget, leaving `runHandlerWithTimeout` (`@bloombot/jobs`'s
    // own `runner.ts`) no slack to abandon a genuinely wedged handler before
    // a fresh retry's own re-upload starts, while the abandoned attempt's
    // own request might still be writing to a socket underneath it (that
    // file's own doc comment: "JavaScript has no way to cancel a Promise
    // already in flight"). One third of the handler's own budget per
    // request, the same "the request gets a smaller bound than the handler
    // that contains it" discipline `packages/discord-rest`'s own
    // `DEFAULT_TIMEOUT_MS` already holds itself to, decoupled from the
    // handler budget entirely.
    timeoutMs: Math.floor(handlerTimeoutMs / 3),
  }
  // FILE-5 — the same directory `@bloombot/actions`' `courseAttachments.attach`
  // action already wrote an attachment's bytes under (both processes share
  // one filesystem, D-2); no argument here means both read
  // `CONFIG.ATTACHMENT_STORAGE_DIR`, the same default `createFilesystemAttachmentStorage`'s
  // own doc comment describes.
  const attachmentStorage = createFilesystemAttachmentStorage()

  const logger: Logger = createLogger(PROCESS_NAME, { logsDir })
  const db: Database = openDatabase(databasePath)
  runMigrations(db)

  // An opaque identifier for this process's own claims (`repos/jobs.ts`'s
  // `ClaimJob.owner`) — stable for the process's lifetime, so every claim
  // it makes is attributable to the same instance.
  const owner = `${PROCESS_NAME}:${randomUUID()}`

  const handlers = new HandlerRegistry()
  handlers.register(
    DISCORD_SCAFFOLD_JOB_KIND,
    createDiscordScaffoldHandler({
      discordRestClient: createDiscordRestClient({
        clientId: discordClientId,
        clientSecret: discordClientSecret,
      }),
      botToken: discordBotToken,
    })
  )
  // ROST-9..12 — this process's second real handler, the same shape the
  // scaffold one above uses: its own `DiscordRestClient`, the same bot
  // token, `categoryChannelCap` left at its default (Discord's real 50).
  handlers.register(
    ROSTER_IMPORT_JOB_KIND,
    createRosterImportHandler({
      discordRestClient: createDiscordRestClient({
        clientId: discordClientId,
        clientSecret: discordClientSecret,
      }),
      botToken: discordBotToken,
    })
  )
  // FILE-1..3 — this process's third and fourth handlers, sharing one
  // `openaiHttpOptions`/`attachmentStorage` pair rather than each building
  // its own (this file's own module comment on why deps are read once, in
  // `main()`).
  handlers.register(
    ATTACH_COURSE_ATTACHMENT_JOB_KIND,
    createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage,
    })
  )
  handlers.register(
    DETACH_COURSE_ATTACHMENT_JOB_KIND,
    createDetachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage,
    })
  )

  let shuttingDown = false
  // `workerHealthStatus` (finding 6 of this rework — `health.ts`'s own
  // comment has the full reasoning) reports a real, fresh database round
  // trip even while draining, only overriding `ready`.
  const health = await startHealthServer(healthPort, () =>
    workerHealthStatus(db, shuttingDown)
  )

  const inFlight = new InFlightJob()
  const loop = createWorkerLoop({
    runOnce: () =>
      runNextJob({
        db,
        logger,
        handlers,
        owner,
        leaseMs,
        handlerTimeoutMs,
        retryPolicy,
      }),
    pollIntervalMs,
    inFlight,
  })

  // Finding 2 of this rework — `runLoopOrExit` (`loop.ts`'s own comment has
  // the full reasoning) exits the process non-zero on a crash rather than
  // merely logging and returning, so this never becomes a zombie: still
  // running, health still `ready: true`, but claiming nothing ever again.
  const loopPromise = runLoopOrExit(loop, { logger })

  logger.info(
    { owner, healthPort, pollIntervalMs, leaseMs, handlerTimeoutMs },
    'apps/worker: started'
  )

  // JOB-5 — closes the database and the health server rather than exiting
  // under load; finishes or releases an in-flight job rather than
  // abandoning it (`shutdown.ts`'s own module comment has the detail on
  // what "releases" can and cannot mean here). A second signal is a no-op,
  // the same guard `apps/bot`'s own `createShutdown` uses.
  const shutdown = createShutdown({
    logger,
    setShuttingDown: () => {
      shuttingDown = true
    },
    stopLoop: () => loop.stop(),
    inFlight,
    closeDb: () => closeDatabase(db),
    closeHealth: () => health.close(),
  })
  const onSignal = (signal: string): void => {
    shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(
          { err: error, signal },
          'apps/worker: failed to shut down cleanly'
        )
        process.exit(1)
      }
    )
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

  await loopPromise
}

main().catch((error: unknown) => {
  // No logger may exist yet if `main` failed before `createLogger` ran (a
  // bad environment) — stderr is the only sink guaranteed to work, the same
  // fallback `apps/bot`/`apps/api`'s own entry points use.
  console.error('apps/worker: failed to start', error)
  process.exit(1)
})
