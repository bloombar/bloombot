/**
 * ENRL-17: `JOIN_LINK_EXPIRY_OPTIONS`'s exact durations, and the guarantees
 * that keep `joinLinkExpirySchema`/`resolveJoinLinkExpiry` from ever
 * disagreeing with it.
 *
 * Rework round 1, must-fix 1: this file exists because the regression
 * coverage that used to pin each duration lived only in
 * `apps/web/tests/join-links.test.tsx`, and was deleted rather than moved
 * when `JoinLinks.tsx` stopped computing timestamps itself — nothing in the
 * repo asserted an exact millisecond duration for any option afterward.
 * Mistyping `16 * 7 * ...` as `16 * 6 * ...` for `'1term'`, say, left every
 * other check (lint, typecheck, the rest of the suite) green while every
 * term-length join link would have stopped admitting students two weeks
 * early — exactly the defect this file's own predecessor in `JoinLinks.tsx`
 * was written to catch.
 */

import { describe, expect, it } from 'vitest'

import {
  JOIN_LINK_EXPIRY_OPTIONS,
  joinLinkExpirySchema,
  resolveJoinLinkExpiry,
  type JoinLinkExpiryValue,
} from '../src/join-link-expiry.js'

describe('JOIN_LINK_EXPIRY_OPTIONS: exact durations (ENRL-17)', () => {
  // Every timed option pinned to its exact millisecond value — not merely
  // bounded ("less than roughly a month") — so a future edit that nudges one
  // duration, even slightly, fails here rather than shipping unnoticed.
  it.each([
    ['none', null],
    ['1d', 24 * 60 * 60 * 1000],
    ['1w', 7 * 24 * 60 * 60 * 1000],
    ['1mo', 30 * 24 * 60 * 60 * 1000],
    ['1term', 16 * 7 * 24 * 60 * 60 * 1000],
  ] as const)('%s is exactly %i ms', (value, durationMs) => {
    const option = JOIN_LINK_EXPIRY_OPTIONS.find((o) => o.value === value)
    expect(option?.durationMs).toBe(durationMs)
  })

  it('offers exactly these five options, in this order — an addition or removal must update this pin deliberately', () => {
    expect(JOIN_LINK_EXPIRY_OPTIONS.map((o) => o.value)).toEqual([
      'none',
      '1d',
      '1w',
      '1mo',
      '1term',
    ])
  })

  it('labels match what an instructor reads in the panel', () => {
    expect(JOIN_LINK_EXPIRY_OPTIONS.map((o) => o.label)).toEqual([
      'Never',
      '1 day',
      '1 week',
      '1 month',
      '1 term (16 weeks)',
    ])
  })
})

describe('joinLinkExpirySchema agrees with JOIN_LINK_EXPIRY_OPTIONS (ENRL-17, must-fix 1)', () => {
  it('accepts every value the options table names', () => {
    for (const option of JOIN_LINK_EXPIRY_OPTIONS) {
      expect(joinLinkExpirySchema.safeParse(option.value).success).toBe(true)
    }
  })

  it('refuses a value the options table does not name', () => {
    expect(joinLinkExpirySchema.safeParse('1y').success).toBe(false)
  })
})

describe('resolveJoinLinkExpiry (ENRL-17)', () => {
  const now = 1_700_000_000_000

  it.each([
    ['1d', 24 * 60 * 60 * 1000],
    ['1w', 7 * 24 * 60 * 60 * 1000],
    ['1mo', 30 * 24 * 60 * 60 * 1000],
    ['1term', 16 * 7 * 24 * 60 * 60 * 1000],
  ] as const)('resolves %s to exactly now + %i ms', (value, durationMs) => {
    expect(resolveJoinLinkExpiry(value, now)).toBe(now + durationMs)
  })

  it("resolves 'none' to null — no expiry", () => {
    expect(resolveJoinLinkExpiry('none', now)).toBeNull()
  })

  // Must-fix 1's other half: failing closed, not open. A value that names no
  // row in `JOIN_LINK_EXPIRY_OPTIONS` throws rather than silently returning
  // `null` ("no expiry") — the same outcome a deliberate `'none'` produces,
  // which is exactly the ambiguity that let a drifted enum issue a
  // never-expiring link with no error at all. Cast past the type system —
  // `joinLinkExpirySchema` itself already refuses this value before it ever
  // reaches a real caller of `resolveJoinLinkExpiry`; this proves the
  // function's own defense holds even if that first line of defense is ever
  // bypassed.
  it('throws for a value the options table does not carry, rather than returning "no expiry"', () => {
    expect(() =>
      resolveJoinLinkExpiry('1y' as JoinLinkExpiryValue, now)
    ).toThrow()
  })
})
