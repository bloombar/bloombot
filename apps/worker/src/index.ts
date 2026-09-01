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
 * No handler is registered yet (`HandlerRegistry` starts empty): this
 * slice builds the queue, the claim, the retry policy and this process —
 * nothing in it makes any existing operation actually use the queue. With
 * an empty registry, `runNextJob` finds no eligible `kind` to claim on
 * every iteration and this process idles, polling and sleeping, until a
 * later phase (roster import, channel provisioning, knowledge-file
 * attachment, project duplication — phases 9 and 10) registers one.
 */

import { randomUUID } from 'node:crypto'

import { CONFIG } from '@bloombot/config'
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  type Database,
} from '@bloombot/db'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import { createLogger, type Logger } from '@bloombot/logger'

import { startHealthServer, workerHealthStatus } from './health.js'
import { createWorkerLoop, runLoopOrExit } from './loop.js'
import { createShutdown, InFlightJob } from './shutdown.js'

const PROCESS_NAME = 'worker'

async function main(): Promise<void> {
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

  const logger: Logger = createLogger(PROCESS_NAME, { logsDir })
  const db: Database = openDatabase(databasePath)
  runMigrations(db)

  // An opaque identifier for this process's own claims (`repos/jobs.ts`'s
  // `ClaimJob.owner`) — stable for the process's lifetime, so every claim
  // it makes is attributable to the same instance.
  const owner = `${PROCESS_NAME}:${randomUUID()}`

  const handlers = new HandlerRegistry()

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
