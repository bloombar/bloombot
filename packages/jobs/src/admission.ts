/**
 * JOB-4 — bounds how many model calls run at once, so thirty students
 * asking at the start of a lecture do not become thirty concurrent calls to
 * a provider. Nothing here is specific to a model call, a database, or even
 * a network request — it is a plain counting semaphore with a bounded wait,
 * used by `@bloombot/core`'s `answer.ts` the one place JOB-4 actually
 * applies it. Deliberately dependency-free (no `@bloombot/db`, no
 * `@bloombot/logger`) so it can be constructed and torn down cheaply in a
 * test with no fake clock and no real timers left dangling — `waitMs: 0`
 * settles on the next tick, not after a real wall-clock second.
 *
 * A caller waits for a slot rather than being refused outright, up to
 * `waitMs` (JOB-4's own text: "requests wait for a slot rather than
 * failing, up to a bound"); past that bound `acquire` resolves with
 * `granted: false` rather than hanging forever — the caller is told
 * plainly it could not be served, not left in silence.
 */

export interface AdmissionGateOptions {
  /** How many callers may hold a slot at once. Configuration, not a constant compiled into a client (JOB-4's own text) — see `docs/DECISIONS.md` for the default and why. */
  limit: number
  /** How long a caller with no free slot waits before being told `granted: false`. */
  waitMs: number
}

export type AdmissionResult =
  { granted: true; release: () => void } | { granted: false }

export interface AdmissionGate {
  /** Waits for a slot, up to `waitMs`. Resolves once a slot is free, or once the wait ceiling elapses — whichever comes first. */
  acquire(): Promise<AdmissionResult>
}

/**
 * Builds an `AdmissionGate` with a fixed `limit` and `waitMs`. FIFO among
 * waiters: the caller that has waited longest is granted the next slot a
 * `release()` frees, rather than an arrival order a `Promise` scheduler
 * happens to pick.
 */
export function createAdmissionGate(
  options: AdmissionGateOptions
): AdmissionGate {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(
      `createAdmissionGate: limit must be a positive integer, got ${options.limit}`
    )
  }
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) {
    throw new Error(
      `createAdmissionGate: waitMs must be >= 0, got ${options.waitMs}`
    )
  }

  let active = 0
  // Waiters currently queued for a slot, in arrival order — each entry is
  // the function that grants that waiter's own `acquire()` its slot.
  const queue: Array<() => void> = []

  function release(): void {
    active -= 1
    const grantNext = queue.shift()
    if (grantNext) {
      active += 1
      grantNext()
    }
  }

  function acquire(): Promise<AdmissionResult> {
    if (active < options.limit) {
      active += 1
      return Promise.resolve({ granted: true, release })
    }

    return new Promise<AdmissionResult>((resolve) => {
      let settled = false

      const grant = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ granted: true, release })
      }

      // Past the wait ceiling: this waiter is told plainly it could not be
      // served (JOB-4), and is removed from the queue so a `release()` that
      // runs later never tries to grant a slot to someone no longer
      // waiting for one.
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const index = queue.indexOf(grant)
        if (index !== -1) queue.splice(index, 1)
        resolve({ granted: false })
      }, options.waitMs)

      queue.push(grant)
    })
  }

  return { acquire }
}
