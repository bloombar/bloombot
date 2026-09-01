/**
 * A job kind maps to a function (JOB-1's "queued as a job rather than held
 * open on an HTTP connection" needs something to actually run the work
 * once claimed). Handlers are registered by whoever wires a process up —
 * `apps/worker` in this slice, later phases' concrete jobs (roster import,
 * channel provisioning, knowledge-file attachment, project duplication) in
 * theirs — never by this package itself, which is why this file imports
 * nothing that knows how to run any particular job.
 */

import type { Database } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'

/** What a handler is given to run one job attempt. */
export interface JobContext {
  organizationId: string
  jobId: string
  /** Which attempt this is — 1 on a job's first run (`repos/jobs.ts#claimNextJob` increments this at claim time, before the handler runs). */
  attempts: number
  db: Database
  logger: Logger
}

/**
 * Runs one job. `payload` is whatever `enqueueJob` was given, round-tripped
 * through `JSON.parse` by `runNextJob` — this package does not know or
 * enforce a shape for it, the same "opaque to the queue" discipline
 * `repos/jobs.ts`'s own module comment holds the database layer to. A
 * handler that throws is treated as a failed attempt (JOB-2); a handler
 * that resolves is treated as succeeded.
 *
 * SRV-6..8 — whatever a handler resolves with is its own report, and
 * `runNextJob` (`runner.ts`) passes it straight through to
 * `repos/jobs.ts#completeJob`'s own `result` argument, the same "opaque to
 * the queue" treatment `payload` already gets — a handler that returns
 * nothing (`Promise<void>`, still fine, still the common case for a job
 * with no report worth keeping) simply leaves the row's `result` `null`.
 */
export type JobHandler = (
  payload: unknown,
  context: JobContext
) => Promise<unknown>

/**
 * A kind-to-handler map, plus the list of kinds it can run — what
 * `runNextJob` passes to `repos/jobs.ts#claimNextJob` so a worker only ever
 * claims a job it actually has a handler for (JOB-3's own claim never
 * strands a job kind nothing here can run).
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>()

  /** Registers `handler` for `kind`. A second registration for the same kind replaces the first — useful for a test overriding one handler in an otherwise-real registry, not expected to happen in production wiring. */
  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler)
  }

  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind)
  }

  /** Every kind this registry can run, in registration order — what `runNextJob` narrows `claimNextJob` to. */
  kinds(): string[] {
    return [...this.handlers.keys()]
  }
}
