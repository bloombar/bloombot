/**
 * `today` (finding 5 of the SURF-1 rework, BOT-11): the daily allowance's
 * day boundary is the *local* calendar day, not UTC — this used to build the
 * string with `toISOString()`, which always reports UTC, so a US-Eastern
 * class's day reset at 8pm local time. `process.env.TZ` is set here and
 * restored in `afterEach`; Node re-reads it on every `Date` call, which is
 * what makes this testable without a real clock.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { today } from '../src/today.js'

const originalTz = process.env.TZ

afterEach(() => {
  if (originalTz === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = originalTz
  }
})

describe('today (finding 5, BOT-11)', () => {
  it('uses the local calendar date, not UTC, when they disagree', () => {
    process.env.TZ = 'America/New_York'
    // 2026-01-02T02:30:00Z is 2026-01-01 21:30 Eastern — 9:30pm local, still
    // the previous UTC-calendar day's evening.
    const now = new Date('2026-01-02T02:30:00Z')

    expect(today(now)).toBe('2026-01-01')
  })

  it('still reports the UTC date when the local timezone is UTC', () => {
    process.env.TZ = 'UTC'
    const now = new Date('2026-01-02T02:30:00Z')

    expect(today(now)).toBe('2026-01-02')
  })

  it('pads single-digit months and days', () => {
    process.env.TZ = 'UTC'
    const now = new Date('2026-03-05T12:00:00Z')

    expect(today(now)).toBe('2026-03-05')
  })

  it('defaults to the real clock when no date is supplied', () => {
    const before = new Date()
    const result = today()
    const after = new Date()

    // Loose on purpose — this only proves the default reads a real clock at
    // call time, not a fixed or stale one; the exact format is covered by
    // the fixed-clock tests above.
    expect(result >= today(before)).toBe(true)
    expect(result <= today(after)).toBe(true)
  })
})
