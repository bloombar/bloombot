/**
 * Claim, run, and record the outcome of exactly one job — the unit
 * `apps/worker`'s own loop (claim, run, complete or fail, sleep, repeat)
 * calls once per iteration.
 */

import { jobs, type Database } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'

import type { JobContext, JobHandler, HandlerRegistry } from './registry.js'
import { backoffDelayMs, type RetryPolicy } from './retry.js'

export interface RunNextJobDependencies {
  db: Database
  logger: Logger
  handlers: HandlerRegistry
  /** An opaque identifier for this worker instance — recorded on the claim (`repos/jobs.ts#ClaimJob`) so a stuck job is at least attributable. */
  owner: string
  /** JOB-3's lease length — how long a claim is honoured before it is treated as released. */
  leaseMs: number
  /**
   * Rework finding 5 — bounds how long one handler call may run before this
   * call gives up on it and fails the attempt with a clear reason, rather
   * than awaiting it unbounded. `apps/worker` runs one job at a time
   * (`loop.ts`'s own module comment), so a handler that never settles would
   * otherwise stall every later claim for as long as it hangs — the lease
   * eventually lapses (JOB-3), but nothing reclaims a stuck job while this
   * single-instance worker is itself the one still "holding" it. Configured
   * rather than a constant, the same reason the lease and the retry
   * schedule already are — see docs/DECISIONS.md for the default and what
   * a timeout that fires on a handler still running underneath it means for
   * idempotency.
   */
  handlerTimeoutMs: number
  retryPolicy: RetryPolicy
}

export type RunNextJobResult =
  /** Nothing eligible to claim — either no job was due, or this registry has no handler registered for any kind. */
  | { outcome: 'empty' }
  | { outcome: 'succeeded'; job: jobs.Job }
  /** JOB-2: retried, with the next attempt due at `nextAttemptAt`. */
  | { outcome: 'retried'; job: jobs.Job; nextAttemptAt: number }
  /** JOB-2's terminal state: attempts exhausted, stopped with `reason` on the row. */
  | { outcome: 'failed'; job: jobs.Job; reason: string }
  /**
   * Rework finding 3 — this claim's own lease lapsed while the handler was
   * running and another worker reclaimed the row before this call's own
   * `completeJob`/`markJobFailed`/`rescheduleJobForRetry` could write to it:
   * `ownsRunningJob`'s `WHERE` no longer matched, so nothing was written
   * under this claim at all. Reported distinctly rather than folded into
   * `succeeded`/`failed`/`retried` — this worker's own handler *did* just
   * finish (or fail), but the row now belongs to whoever reclaimed it, so
   * whichever outcome this call believed it had is not what actually landed
   * on the row. `job` is read fresh (`jobs.getJob`), not the stale claimed
   * row this call started with.
   */
  | { outcome: 'superseded'; job: jobs.Job }

/**
 * Rework finding 3 — the write `completeJob`/`markJobFailed`/
 * `rescheduleJobForRetry` each attempt after the handler settles can lose
 * the race: the lease this call claimed the job under lapsed while the
 * handler was still running, another worker reclaimed the row, and that
 * write's own `ownsRunningJob` `WHERE` clause no longer matches — the
 * repo function returns `undefined` rather than throwing. That is the one
 * moment a job is genuinely at risk of running twice (this worker's handler
 * really did just finish or fail, but the row now belongs to whoever
 * reclaimed it), so it is reported as its own outcome — at warning, since
 * an operator needs to know — rather than silently reported as whatever
 * this call believed had happened.
 */
function superseded(
  deps: RunNextJobDependencies,
  job: jobs.Job,
  attempted: 'succeeded' | 'failed' | 'retried'
): RunNextJobResult {
  deps.logger.warn(
    { jobId: job.id, kind: job.kind, owner: deps.owner, attempted },
    '@bloombot/jobs: this claim was superseded before its outcome could be recorded — the job may run twice'
  )
  return {
    outcome: 'superseded',
    // Read fresh rather than the stale, already-claimed `job` this call
    // started with — that row belongs to whoever reclaimed it now.
    job: jobs.getJob(job.organizationId, job.id, deps.db) ?? job,
  }
}

/** Finding 7 — `error instanceof Error ? error.message : String(error)` turns a non-`Error` throw (`throw { code: 42 }`) into the useless `"[object Object]"` in the row JOB-2 makes the visible artefact. Falls back to `JSON.stringify` so a thrown object or array keeps something a reader can actually use. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    // A value JSON.stringify itself refuses (a circular structure, a
    // BigInt) — String(error) is the last resort, not the first.
    return String(error)
  }
}

/**
 * Rework finding 5 — races `handler(payload, context)` against a timer,
 * rejecting with a clear, purpose-built reason if `timeoutMs` elapses
 * first. JavaScript has no way to cancel a `Promise` already in flight, so
 * a handler that keeps running past this point keeps running — this only
 * stops *awaiting* it, so `runNextJob` can go on to fail (or retry) the
 * attempt instead of hanging. See docs/DECISIONS.md for what that means for
 * a handler's own idempotency.
 */
function runHandlerWithTimeout(
  handler: JobHandler,
  payload: unknown,
  context: JobContext,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `handler for job ${context.jobId} did not settle within ${timeoutMs}ms (JOB-5)`
        )
      )
    }, timeoutMs)
    handler(payload, context).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error as Error)
      }
    )
  })
}

/**
 * Claims the next eligible job this registry has a handler for
 * (`HandlerRegistry.kinds()` narrows `repos/jobs.ts#claimNextJob`'s own
 * candidate search), runs it, and records the outcome. Never throws for an
 * ordinary handler failure — JOB-2's retry-or-fail bookkeeping is this
 * function's own job, not the caller's, the same "ordinary outcome, not an
 * exception" discipline `@bloombot/core`'s `answerQuestion` holds itself to
 * for its own discriminated result.
 */
export async function runNextJob(
  deps: RunNextJobDependencies
): Promise<RunNextJobResult> {
  const kinds = deps.handlers.kinds()
  if (kinds.length === 0) return { outcome: 'empty' }

  const job = jobs.claimNextJob(
    kinds,
    { owner: deps.owner, leaseMs: deps.leaseMs },
    deps.db
  )
  if (!job) return { outcome: 'empty' }

  // `claimNextJob` only ever claims a kind this registry narrowed its own
  // search to, so a missing handler here would mean the registry changed
  // shape between building `kinds` and this lookup — defensive, not a case
  // `runNextJob`'s own contract expects a caller to hit.
  const handler = deps.handlers.get(job.kind)
  if (!handler) {
    const reason = `no handler registered for job kind "${job.kind}"`
    deps.logger.error(
      { jobId: job.id, kind: job.kind },
      `@bloombot/jobs: ${reason}`
    )
    const failed = jobs.markJobFailed(
      job.organizationId,
      job.id,
      { owner: deps.owner, claimExpiresAt: job.claimExpiresAt! },
      reason,
      deps.db
    )
    return { outcome: 'failed', job: failed ?? job, reason }
  }

  let payload: unknown
  try {
    payload = JSON.parse(job.payload) as unknown
  } catch (error) {
    // A malformed payload will fail identically on every retry — there is
    // nothing a backoff buys here, so this goes straight to `failed`
    // regardless of how many attempts remain.
    const reason = `could not parse job payload: ${error instanceof Error ? error.message : String(error)}`
    deps.logger.error(
      { err: error, jobId: job.id },
      `@bloombot/jobs: ${reason}`
    )
    const failed = jobs.markJobFailed(
      job.organizationId,
      job.id,
      { owner: deps.owner, claimExpiresAt: job.claimExpiresAt! },
      reason,
      deps.db
    )
    return { outcome: 'failed', job: failed ?? job, reason }
  }

  const claim = { owner: deps.owner, claimExpiresAt: job.claimExpiresAt! }

  try {
    await runHandlerWithTimeout(
      handler,
      payload,
      {
        organizationId: job.organizationId,
        jobId: job.id,
        attempts: job.attempts,
        db: deps.db,
        logger: deps.logger,
      },
      deps.handlerTimeoutMs
    )
    const completed = jobs.completeJob(
      job.organizationId,
      job.id,
      claim,
      deps.db
    )
    if (!completed) return superseded(deps, job, 'succeeded')
    return { outcome: 'succeeded', job: completed }
  } catch (error) {
    const reason = describeError(error)
    deps.logger.error(
      {
        err: error,
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
      },
      '@bloombot/jobs: a job attempt failed'
    )

    if (job.attempts >= job.maxAttempts) {
      const failed = jobs.markJobFailed(
        job.organizationId,
        job.id,
        claim,
        reason,
        deps.db
      )
      if (!failed) return superseded(deps, job, 'failed')
      return { outcome: 'failed', job: failed, reason }
    }

    const nextAttemptAt =
      Date.now() + backoffDelayMs(job.attempts, deps.retryPolicy)
    const rescheduled = jobs.rescheduleJobForRetry(
      job.organizationId,
      job.id,
      claim,
      { reason, nextAttemptAt },
      deps.db
    )
    if (!rescheduled) return superseded(deps, job, 'retried')
    return {
      outcome: 'retried',
      job: rescheduled,
      nextAttemptAt,
    }
  }
}
