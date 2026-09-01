/**
 * COST-1/COST-6's per-model pricing table.
 *
 * Rates live in configuration, not in code (this slice's own brief): the
 * defaults below are approximate, publicly listed per-token rates as of
 * this writing, not a promise this platform keeps them current — an
 * operator overrides `MODEL_PRICING_JSON` (`env.ts`) the moment a provider's
 * own pricing changes, without a code change or a redeploy.
 *
 * Every rate is integer micros per **million** tokens (not per token, which
 * would round every real call to zero under integer arithmetic long before
 * `costMicros` itself is computed) — the same "money as INTEGER micros"
 * rule D-2 already holds `cost_ledger_entries.cost_micros` to, carried one
 * step earlier into the table it is computed from.
 */

import { z } from 'zod'

/** One model's own rate — what a million input tokens costs, and what a million output tokens costs, in micros. */
export interface ModelRate {
  inputMicrosPerMillionTokens: number
  outputMicrosPerMillionTokens: number
}

/**
 * The whole table: a rate per known model name, plus `defaultRate` — the
 * documented fallback `computeCost` (`@bloombot/core`'s `pricing.ts`) applies
 * to a model this table has no entry for, so an unpriced model still costs
 * something real rather than silently costing zero (COST-6).
 */
export interface PricingTable {
  rates: Record<string, ModelRate>
  defaultRate: ModelRate
}

const rateSchema = z.object({
  inputMicrosPerMillionTokens: z.number().int().nonnegative(),
  outputMicrosPerMillionTokens: z.number().int().nonnegative(),
})

const pricingTableSchema = z.object({
  rates: z.record(z.string(), rateSchema),
  defaultRate: rateSchema,
})

/**
 * Approximate, publicly listed OpenAI Responses API rates as of this
 * writing (gpt-4o: $2.50 / $10.00 per million input/output tokens;
 * gpt-4o-mini: $0.15 / $0.60) — `AI-4`'s own default model and the smaller
 * model courses sometimes pin to. `defaultRate` reuses `gpt-4o`'s own rate:
 * the platform's own default model (`@bloombot/openai`'s `DEFAULT_MODEL`)
 * is what an unnamed model is likeliest to actually be billed at, closer to
 * the truth than an arbitrary round number would be.
 */
const DEFAULT_PRICING: PricingTable = {
  rates: {
    'gpt-4o': {
      inputMicrosPerMillionTokens: 2_500_000,
      outputMicrosPerMillionTokens: 10_000_000,
    },
    'gpt-4o-mini': {
      inputMicrosPerMillionTokens: 150_000,
      outputMicrosPerMillionTokens: 600_000,
    },
  },
  defaultRate: {
    inputMicrosPerMillionTokens: 2_500_000,
    outputMicrosPerMillionTokens: 10_000_000,
  },
}

/** `MODEL_PRICING_JSON`'s own default value (`env.ts`) — the JSON form of `DEFAULT_PRICING` above, computed once at module load rather than hand-copied out of sync with it. */
export const DEFAULT_PRICING_JSON = JSON.stringify(DEFAULT_PRICING)

/**
 * Parse and validate a pricing table, defaulting to `CONFIG.MODEL_PRICING_JSON`
 * when `json` is omitted. Throws (the same "fail immediately, not on the
 * first request" discipline `parseEnv` already holds the rest of the
 * environment to, CFG-5) when the value is not valid JSON, or does not
 * match `pricingTableSchema` — a malformed rate is a startup-time
 * configuration error, not a `0` quietly substituted for every call.
 */
export function getModelPricingTable(json?: string): PricingTable {
  // A dynamic `import` would be circular (`env.ts` imports this module for
  // its own default); `process.env` is read directly instead, mirroring the
  // split `admin.ts` already takes between its own env-reading and
  // `env.ts`'s schema. An empty string is treated the same as unset —
  // `env.example`'s own documented, deliberately blank value for this
  // variable — for *both* `json` and `process.env.MODEL_PRICING_JSON`, not
  // only the latter: `apps/bot`'s own `main()` calls this with
  // `CONFIG.MODEL_PRICING_JSON` explicitly, and zod's `.default(...)` only
  // ever applies when a key is *absent* from the environment, never when it
  // is present but blank — so `env.example`'s own blank line reaches this
  // function as `json: ''`, not `json: undefined`, and `json ?? …` alone
  // would let that empty string through to `JSON.parse` unchanged (a crash
  // before the gateway ever connects, the exact deployment our own
  // `docs/RUNNING_LOCALLY.md` walks an operator into). Guarding the
  // argument the same way as the environment variable closes that gap.
  const isBlank = (value: string | undefined): value is undefined =>
    value === undefined || value.length === 0
  const raw = !isBlank(json)
    ? json
    : !isBlank(process.env.MODEL_PRICING_JSON)
      ? process.env.MODEL_PRICING_JSON
      : DEFAULT_PRICING_JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `MODEL_PRICING_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  const result = pricingTableSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `MODEL_PRICING_JSON does not match the expected shape: ${result.error.message}`
    )
  }
  return result.data
}
