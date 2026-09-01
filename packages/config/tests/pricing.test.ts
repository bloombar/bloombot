import { afterEach, describe, expect, it } from 'vitest'

import { getModelPricingTable } from '@bloombot/config'

describe('getModelPricingTable (COST-1/COST-6)', () => {
  const original = process.env.MODEL_PRICING_JSON

  afterEach(() => {
    if (original === undefined) delete process.env.MODEL_PRICING_JSON
    else process.env.MODEL_PRICING_JSON = original
  })

  it('returns a documented default rate for the platform`s own default model when unset', () => {
    delete process.env.MODEL_PRICING_JSON

    const table = getModelPricingTable()

    expect(table.rates['gpt-4o']).toBeDefined()
    expect(table.defaultRate).toBeDefined()
    expect(table.defaultRate.inputMicrosPerMillionTokens).toBeGreaterThan(0)
  })

  it('treats an empty value the same as unset — the same shape env.example documents', () => {
    process.env.MODEL_PRICING_JSON = ''

    const table = getModelPricingTable()

    expect(table.rates['gpt-4o']).toBeDefined()
  })

  it('reads an explicit override, not captured at import', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({
      rates: {
        'custom-model': {
          inputMicrosPerMillionTokens: 1,
          outputMicrosPerMillionTokens: 2,
        },
      },
      defaultRate: {
        inputMicrosPerMillionTokens: 1,
        outputMicrosPerMillionTokens: 2,
      },
    })

    const table = getModelPricingTable()

    expect(table.rates['custom-model']).toEqual({
      inputMicrosPerMillionTokens: 1,
      outputMicrosPerMillionTokens: 2,
    })
    expect(table.rates['gpt-4o']).toBeUndefined()
  })

  it('accepts an explicit argument over process.env', () => {
    process.env.MODEL_PRICING_JSON = JSON.stringify({
      rates: {},
      defaultRate: {
        inputMicrosPerMillionTokens: 9,
        outputMicrosPerMillionTokens: 9,
      },
    })

    const table = getModelPricingTable(
      JSON.stringify({
        rates: {},
        defaultRate: {
          inputMicrosPerMillionTokens: 5,
          outputMicrosPerMillionTokens: 5,
        },
      })
    )

    expect(table.defaultRate.inputMicrosPerMillionTokens).toBe(5)
  })

  it('throws on invalid JSON rather than silently pricing every call at zero', () => {
    expect(() => getModelPricingTable('not json')).toThrow(/not valid JSON/)
  })

  it('throws when the JSON does not match the expected shape', () => {
    expect(() =>
      getModelPricingTable(JSON.stringify({ rates: 'nope' }))
    ).toThrow(/expected shape/)
  })
})
