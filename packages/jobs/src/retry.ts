/**
 * JOB-2's retry policy: exponential backoff from a base delay, bounded by a
 * maximum number of attempts. Kept as pure arithmetic, no database and no
 * clock read inside it — `runner.ts` supplies the attempt number and reads
 * `Date.now()` itself, the same "never read from a clock inside a
 * repo/policy function" discipline `usage.ts`'s own module comment holds
 * itself to, so this is trivially testable without a fake timer.
 *
 * See `docs/DECISIONS.md` for why these particular numbers (the schedule
 * and the bound) are configuration rather than constants, and why they are
 * what they are.
 */

export interface RetryPolicy {
  /** JOB-2's bound: a job is retried at most this many times before it stops in a terminal `failed` state. */
  maxAttempts: number
  /** The delay before the *second* attempt (the first retry) — attempt 1 never waits, since it runs the moment the job is first claimed. */
  baseDelayMs: number
  /** Multiplies the delay on each subsequent attempt. `1` is a fixed delay; anything greater than `1` grows the wait, which is what "backoff" means here. */
  backoffFactor: number
}

/**
 * The delay before the *next* attempt, given that attempt `attempt` (1-indexed
 * — `repos/jobs.ts#claimNextJob` increments `attempts` at claim time, so a
 * job's first run is attempt `1`) just failed: `baseDelayMs * backoffFactor
 * ^ (attempt - 1)`, so the delay before attempt 2 is `baseDelayMs` itself,
 * before attempt 3 is `baseDelayMs * backoffFactor`, and so on.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(
      `backoffDelayMs: attempt must be a positive integer, got ${attempt}`
    )
  }
  return Math.round(policy.baseDelayMs * policy.backoffFactor ** (attempt - 1))
}
