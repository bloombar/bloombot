/**
 * COST-1/COST-6 — `computeCost`'s own pricing arithmetic, independent of
 * the answering pipeline it feeds (`answer.test.ts` exercises that
 * end-to-end).
 */

import { describe, expect, it } from 'vitest'

import { computeCost, type PricingTable } from '../src/pricing.js'

const PRICING: PricingTable = {
  rates: {
    'known-model': {
      inputMicrosPerMillionTokens: 2_000_000,
      outputMicrosPerMillionTokens: 4_000_000,
    },
  },
  defaultRate: {
    inputMicrosPerMillionTokens: 1_000_000,
    outputMicrosPerMillionTokens: 1_000_000,
  },
}

/** `text` is ignored on the measured path (`usage` present) — a fixed, unused value keeps every measured-path call below focused on what it is actually testing. */
const UNUSED_TEXT = { question: 'unused', answer: 'unused' }

describe('computeCost', () => {
  it('measures a known model against its own rate', () => {
    const result = computeCost(
      'known-model',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      PRICING,
      UNUSED_TEXT
    )

    expect(result).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costMicros: 6_000_000, // 2_000_000 + 4_000_000
      measurement: 'measured',
    })
  })

  it('rounds a fractional cost to the nearest integer micro, half up, rather than accumulating a float', () => {
    // `known-model`'s own rate (2 micros/token exactly) can never land on a
    // fraction — a rate deliberately chosen not to divide evenly is what
    // actually exercises a rounding decision, rather than merely restating
    // an already-integer result.
    const fractionalPricing: PricingTable = {
      rates: {
        'known-model': {
          inputMicrosPerMillionTokens: 2_500_000, // 2.5 micros/token
          outputMicrosPerMillionTokens: 1_500_000, // 1.5 micros/token
        },
      },
      defaultRate: PRICING.defaultRate,
    }

    const result = computeCost(
      'known-model',
      { inputTokens: 1, outputTokens: 1 },
      fractionalPricing,
      UNUSED_TEXT
    )

    // 1 * 2.5 + 1 * 1.5 = 4 micros exactly — still not fractional enough to
    // prove which way rounding goes.
    expect(result.costMicros).toBe(4)

    // 1 input token alone: 2.5 micros exactly, half up rounds to 3 — the
    // same half-up rule every other rounding in this ledger holds to (D-2).
    const halfUp = computeCost(
      'known-model',
      { inputTokens: 1, outputTokens: 0 },
      fractionalPricing,
      UNUSED_TEXT
    )
    expect(halfUp.costMicros).toBe(3)
  })

  // COST-6 — "a provider response with no usage records an estimate,
  // flagged as such": the request and answer text are still in hand, so the
  // estimate is priced from their own length (finding 2 of the COST-1
  // rework), not recorded as a flat `costMicros: 0`.
  it('estimates tokens and cost from the request/answer text when the provider reported no usage', () => {
    const result = computeCost('known-model', undefined, PRICING, {
      question: 'x'.repeat(8), // ~2 tokens at 4 characters/token
      answer: 'y'.repeat(4), // ~1 token
    })

    expect(result).toEqual({
      inputTokens: 2,
      outputTokens: 1,
      costMicros: 8, // 2 * 2_000_000/1e6 + 1 * 4_000_000/1e6
      measurement: 'estimated',
    })
  })

  it('estimates a nonzero cost even for a model with no configured rate — never the flat zero this used to record', () => {
    const result = computeCost('unknown-model', undefined, PRICING, {
      question: 'x'.repeat(8),
      answer: 'y'.repeat(4),
    })

    expect(result.measurement).toBe('estimated')
    expect(result.costMicros).toBeGreaterThan(0)
  })

  // COST-6 — "a model with no known rate must not silently cost zero":
  // priced against `defaultRate`, not zero, and flagged as an estimate.
  it('prices an unpriced model against the default rate, flagged as an estimate — not zero', () => {
    const result = computeCost(
      'unknown-model',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      PRICING,
      UNUSED_TEXT
    )

    expect(result.measurement).toBe('estimated')
    expect(result.costMicros).toBe(2_000_000) // 1_000_000 + 1_000_000, the default rate
    expect(result.costMicros).not.toBe(0)
  })
})
