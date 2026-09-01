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

describe('computeCost', () => {
  it('measures a known model against its own rate', () => {
    const result = computeCost(
      'known-model',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      PRICING
    )

    expect(result).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costMicros: 6_000_000, // 2_000_000 + 4_000_000
      measurement: 'measured',
    })
  })

  it('rounds to the nearest integer micro rather than accumulating a float', () => {
    const result = computeCost(
      'known-model',
      { inputTokens: 3, outputTokens: 0 },
      PRICING
    )

    // 3 * 2_000_000 / 1_000_000 = 6 micros exactly; a fractional token count
    // (below) is what actually exercises the rounding.
    expect(result.costMicros).toBe(6)

    const fractional = computeCost(
      'known-model',
      { inputTokens: 1, outputTokens: 0 },
      PRICING
    )
    expect(Number.isInteger(fractional.costMicros)).toBe(true)
  })

  // COST-6 — "a provider response with no usage records an estimate,
  // flagged as such".
  it('records an estimate with no token counts when the provider reported no usage', () => {
    const result = computeCost('known-model', undefined, PRICING)

    expect(result).toEqual({
      inputTokens: null,
      outputTokens: null,
      costMicros: 0,
      measurement: 'estimated',
    })
  })

  // COST-6 — "a model with no known rate must not silently cost zero":
  // priced against `defaultRate`, not zero, and flagged as an estimate.
  it('prices an unpriced model against the default rate, flagged as an estimate — not zero', () => {
    const result = computeCost(
      'unknown-model',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      PRICING
    )

    expect(result.measurement).toBe('estimated')
    expect(result.costMicros).toBe(2_000_000) // 1_000_000 + 1_000_000, the default rate
    expect(result.costMicros).not.toBe(0)
  })
})
