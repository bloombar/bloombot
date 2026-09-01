/**
 * `backoffDelayMs` (JOB-2) — pure arithmetic, no clock and no database, so
 * this is the cheap place to pin the exact schedule.
 */

import { describe, expect, it } from 'vitest'

import { backoffDelayMs, type RetryPolicy } from '../src/retry.js'

const policy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  backoffFactor: 2,
}

describe('backoffDelayMs (JOB-2)', () => {
  it('the delay before the second attempt equals the base delay', () => {
    expect(backoffDelayMs(1, policy)).toBe(1000)
  })

  it('doubles on each subsequent attempt, matching the configured factor', () => {
    expect(backoffDelayMs(1, policy)).toBe(1000)
    expect(backoffDelayMs(2, policy)).toBe(2000)
    expect(backoffDelayMs(3, policy)).toBe(4000)
    expect(backoffDelayMs(4, policy)).toBe(8000)
  })

  it('a factor of 1 is a fixed delay, not growing backoff', () => {
    const fixed: RetryPolicy = {
      maxAttempts: 5,
      baseDelayMs: 500,
      backoffFactor: 1,
    }
    expect(backoffDelayMs(1, fixed)).toBe(500)
    expect(backoffDelayMs(4, fixed)).toBe(500)
  })

  it('rejects an attempt below 1', () => {
    expect(() => backoffDelayMs(0, policy)).toThrow()
    expect(() => backoffDelayMs(-1, policy)).toThrow()
  })

  it('rejects a non-integer attempt', () => {
    expect(() => backoffDelayMs(1.5, policy)).toThrow()
  })
})
