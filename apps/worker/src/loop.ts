/**
 * The worker's own cycle (JOB-5's brief: "claim, run, complete or fail,
 * sleep, repeat"). Factored out of `index.ts` so it is testable with a
 * stand-in for `runNextJob` and no real database, timer or handler.
 */

import type { Logger } from '@bloombot/logger'

import type { InFlightJob } from './shutdown.js'

/** The subset of `@bloombot/jobs`'s `runNextJob` this loop needs — just enough to decide whether to sleep before trying again. */
export type RunOnce = () => Promise<{ outcome: string }>

export interface WorkerLoopDependencies {
  runOnce: RunOnce
  /** How long to sleep once a claim attempt finds nothing to run. */
  pollIntervalMs: number
  /** Tracks each `runOnce()` call so shutdown can wait for the current one. */
  inFlight: InFlightJob
  /** Overridable so a test can run this loop for several iterations without a real timer. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
}

export interface WorkerLoop {
  /** Runs until `stop()` is called. Resolves once the current iteration (if any) finishes. */
  run: () => Promise<void>
  /** Stops the loop from starting another claim once its current iteration (if any) settles. Does not itself wait for that — callers that need to know it actually stopped await `run()`'s own promise, or `shutdown.ts`'s own `InFlightJob.drain`. */
  stop: () => void
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function createWorkerLoop(deps: WorkerLoopDependencies): WorkerLoop {
  let stopping = false
  const sleep = deps.sleep ?? realSleep

  async function run(): Promise<void> {
    while (!stopping) {
      const result = await deps.inFlight.track(deps.runOnce())
      // A stop requested while that call was in flight — do not sleep and
      // do not start another claim; the loop is done.
      if (stopping) break
      if (result.outcome === 'empty') {
        await sleep(deps.pollIntervalMs)
      }
    }
  }

  return {
    run,
    stop: () => {
      stopping = true
    },
  }
}

/**
 * Rework finding 2 — runs `loop` until `stop()` is called or `run()`
 * itself rejects. `index.ts` used to attach a bare `.catch()` to
 * `loop.run()` that only logged: `main()` then awaited that now-resolved
 * promise and fell through to the end of its own body, leaving the health
 * server (and the signal handlers registered after it) keeping the process
 * alive — a zombie whose PID stays up and whose `checkWorkerHealth` keeps
 * reporting `ready: true` (the database is still reachable) even though
 * nothing will ever claim another job again, indistinguishable from a
 * healthy idle worker to anything only watching the health endpoint. A
 * transient error thrown out of `runOnce` (a blip inside `claimNextJob`,
 * say) does exactly this.
 *
 * `apps/bot`'s own health design already leans on a crashed process
 * actually exiting so a process manager's restart policy (pm2 — see
 * docs/DECISIONS.md's "why not a richer health payload") is what recovers
 * it, rather than a health check flipping unhealthy and something else
 * noticing on its own schedule. This follows the same choice: log, then
 * exit non-zero, so pm2 restarts the process with a fresh claim rather than
 * leaving a wedged one running indefinitely.
 */
export async function runLoopOrExit(
  loop: Pick<WorkerLoop, 'run'>,
  deps: {
    logger: Pick<Logger, 'error'>
    /** Overridable so a test can observe the call instead of ending the test process. Defaults to `process.exit`. */
    exit?: (code: number) => void
  }
): Promise<void> {
  const exit = deps.exit ?? process.exit
  try {
    await loop.run()
  } catch (error) {
    deps.logger.error(
      { err: error },
      'apps/worker: the job loop crashed — exiting so a process manager can restart it'
    )
    exit(1)
  }
}
