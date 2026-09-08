/**
 * JOB-5's shutdown path: finishes or releases what this process holds
 * rather than abandoning it. Mirrors the drain-then-close shape
 * `apps/bot`'s own `shutdown.ts` already established, sized to a worker
 * that runs one job at a time rather than many concurrent handlers — at
 * most one `runNextJob` call is ever in flight here, so `InFlightJob`
 * tracks that one promise instead of `apps/bot`'s `Set`-backed
 * `InFlightTracker`.
 *
 * What "releases what it holds" actually means for a job already running
 * when a signal arrives: there is no way to preempt a handler mid-`await` —
 * JavaScript has no cooperative cancellation here, and forcing the claim
 * open before the handler itself settles would let a second worker start
 * the same job while the first is still finishing it, exactly the
 * double-run JOB-3 forbids. So this waits, bounded, for the in-flight call
 * to reach its own `completeJob`/`rescheduleJobForRetry`/`markJobFailed`
 * (`@bloombot/jobs`'s `runNextJob` already calls the right one) — "finishes"
 * for the common case. Past the bound, this process shuts down anyway and
 * logs that it did: the claim is not explicitly released, but JOB-3's own
 * lease already guarantees it stops being stranded once the lease expires
 * — "abandoning" only for a wedged handler, and bounded even then.
 */

/** Tracks the one job-run promise the worker loop currently has in flight, if any. */
export class InFlightJob {
  private current: Promise<unknown> | null = null

  /** Registers `promise` as in flight; stops tracking it once it settles, either way. Returns `promise` unchanged. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.current = promise
    const clear = (): void => {
      if (this.current === promise) this.current = null
    }
    promise.then(clear, clear)
    return promise
  }

  get isRunning(): boolean {
    return this.current !== null
  }

  /** Resolves once the in-flight job settles, or `timeoutMs` has elapsed — whichever comes first, so one wedged handler cannot hang shutdown forever (the same bound `apps/bot`'s own `InFlightTracker.drain` uses). */
  async drain(timeoutMs: number): Promise<void> {
    const promise = this.current
    if (!promise) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      promise.then(finish, finish)
    })
  }
}

export interface ShutdownDependencies {
  logger: {
    info: (fields: Record<string, unknown>, message: string) => void
    warn: (fields: Record<string, unknown>, message: string) => void
  }
  /** Stops the health endpoint from reporting ready while this process is going away — set before anything async runs, the same discipline `apps/bot`'s own `setDisconnected` holds itself to. */
  setShuttingDown: () => void
  /** Stops the worker loop from starting a *new* claim once its current one (if any) settles. */
  stopLoop: () => void
  /** Tracks the currently in-flight `runNextJob` call, if any. */
  inFlight: InFlightJob
  /** Closes the database connection. */
  closeDb: () => void
  /** Stops the health server. */
  closeHealth: () => Promise<void>
  /** Bounded wait for an in-flight job to settle. Defaults to 30000ms — background jobs are expected to run longer than one request, so this is generous compared to `apps/bot`'s own 5000ms default for a single answer. */
  drainTimeoutMs?: number
}

/**
 * Builds the one shutdown function this process calls from both `SIGINT`
 * and `SIGTERM`. A second call — the same signal twice, or a different one
 * — is a no-op rather than a second teardown racing the first, the same
 * guard `apps/bot`'s own `createShutdown` uses.
 */
export function createShutdown(
  deps: ShutdownDependencies
): (signal: string) => Promise<void> {
  let shuttingDown = false
  return async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    deps.logger.info({ signal }, 'apps/worker: shutting down')
    deps.setShuttingDown()
    deps.stopLoop()

    const wasRunning = deps.inFlight.isRunning
    await deps.inFlight.drain(deps.drainTimeoutMs ?? 30_000)
    if (wasRunning && deps.inFlight.isRunning) {
      deps.logger.warn(
        { signal },
        'apps/worker: shutting down with a job still in flight past the drain timeout — its claim is not released here, and will lapse on its own lease (JOB-3)'
      )
    }

    deps.closeDb()
    await deps.closeHealth()
  }
}
