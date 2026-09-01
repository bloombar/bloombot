/**
 * The worker's own cycle (JOB-5's brief: "claim, run, complete or fail,
 * sleep, repeat"). Factored out of `index.ts` so it is testable with a
 * stand-in for `runNextJob` and no real database, timer or handler.
 */

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
