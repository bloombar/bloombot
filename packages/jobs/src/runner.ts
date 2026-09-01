/**
 * Claim, run, and record the outcome of exactly one job — the unit
 * `apps/worker`'s own loop (claim, run, complete or fail, sleep, repeat)
 * calls once per iteration.
 */

import { jobs, type Database } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'

import type { HandlerRegistry } from './registry.js'
import { backoffDelayMs, type RetryPolicy } from './retry.js'

export interface RunNextJobDependencies {
  db: Database
  logger: Logger
  handlers: HandlerRegistry
  /** An opaque identifier for this worker instance — recorded on the claim (`repos/jobs.ts#ClaimJob`) so a stuck job is at least attributable. */
  owner: string
  /** JOB-3's lease length — how long a claim is honoured before it is treated as released. */
  leaseMs: number
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
    await handler(payload, {
      organizationId: job.organizationId,
      jobId: job.id,
      attempts: job.attempts,
      db: deps.db,
      logger: deps.logger,
    })
    const completed = jobs.completeJob(
      job.organizationId,
      job.id,
      claim,
      deps.db
    )
    return { outcome: 'succeeded', job: completed ?? job }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
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
      return { outcome: 'failed', job: failed ?? job, reason }
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
    return {
      outcome: 'retried',
      job: rescheduled ?? job,
      nextAttemptAt,
    }
  }
}
