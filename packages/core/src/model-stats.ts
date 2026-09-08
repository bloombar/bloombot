/**
 * COST-5 — "the model provider's error rate" is observable, not inferred.
 *
 * A thin `ModelClient` (`ports.ts`) decorator that counts every call and
 * every failure, so whichever process actually builds a real client
 * (`apps/bot`'s own `main()`, mirroring how it already wraps `admission`
 * around the answering path) can report the running error rate from its own
 * health endpoint without a separate metrics system. Pure counting, no
 * vendor type, no network of its own — the same "no vendor SDK, no HTTP" the
 * rest of this file's package (`ports.ts`'s own module comment) already
 * holds every file here to.
 */

import type { ModelAnswer, ModelClient, ModelRequest } from './ports.js'

/** A snapshot of what `createCountingModelClient` has observed since it was built. */
export interface ModelCallStats {
  /** Every call attempted, successful or not. */
  calls: number
  /** Calls that threw — `ModelClient.ask`'s own contract for "this call failed" (CORE-5 reads the same signal to fall back to an apology). */
  errors: number
  /** `errors / calls`, or `0` when no call has happened yet — division by a call count of zero would be `NaN`, which no health endpoint should ever have to special-case. */
  errorRate: number
}

/** A `ModelClient` that counts calls and failures, and a way to read the running total back. */
export interface CountingModelClient {
  client: ModelClient
  getStats: () => ModelCallStats
}

/**
 * Wrap `inner` so every `ask` is counted. A failure is still rethrown,
 * unchanged — this wrapper only observes, it never changes what `answer.ts`
 * (or any other caller) sees happen.
 */
export function createCountingModelClient(
  inner: ModelClient
): CountingModelClient {
  let calls = 0
  let errors = 0

  const client: ModelClient = {
    async ask(request: ModelRequest): Promise<ModelAnswer> {
      calls += 1
      try {
        return await inner.ask(request)
      } catch (error) {
        errors += 1
        throw error
      }
    },
  }

  return {
    client,
    getStats: () => ({
      calls,
      errors,
      errorRate: calls === 0 ? 0 : errors / calls,
    }),
  }
}
