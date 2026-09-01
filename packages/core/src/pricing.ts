/**
 * COST-1/COST-6's cost computation — pure, and deliberately independent of
 * `@bloombot/config`'s own `PricingTable` type (this file's own module
 * comment on `ModelRate`/`PricingTable` below has why): `answer.ts` is
 * handed a `PricingTable` shaped exactly like `@bloombot/config`'s, through
 * `AnswerDependencies.pricing`, the same "dependencies as arguments, only
 * the process reads `CONFIG`" discipline `docs/DECISIONS.md` (D-29) already
 * holds this package's `admission`/`model`/`db` to. `apps/bot`'s own
 * `main()` builds the real table from `CONFIG.MODEL_PRICING_JSON` and hands
 * it down, unchanged in shape.
 */

/** One model's own rate. Structurally identical to `@bloombot/config`'s own `ModelRate` — restated here, not imported, so this package keeps its zero-dependency-on-`@bloombot/config` discipline (D-29) even for a type. */
export interface ModelRate {
  inputMicrosPerMillionTokens: number
  outputMicrosPerMillionTokens: number
}

/** The whole table `computeCost` prices a call against. Structurally identical to `@bloombot/config`'s own `PricingTable` — see this file's own module comment for why it is restated rather than imported. */
export interface PricingTable {
  rates: Record<string, ModelRate>
  defaultRate: ModelRate
}

/** What `computeCost` returns — everything `answer.ts` needs to hand `@bloombot/db`'s `costLedger.recordCostLedgerEntry` (`repos/cost-ledger.ts`'s own `NewCostLedgerEntry`, minus the attribution fields only `answer.ts` itself knows). */
export interface ComputedCost {
  inputTokens: number | null
  outputTokens: number | null
  costMicros: number
  measurement: 'measured' | 'estimated'
}

/**
 * Price one model call.
 *
 * - `usage` is `undefined` exactly when `@bloombot/openai`'s own
 *   `extractUsage` (MDL-5) found none to report — COST-6: recorded as an
 *   **estimate**, with no token counts to claim (`null`, not `0` — this
 *   file's own module comment on `NewCostLedgerEntry`'s twin in
 *   `repos/cost-ledger.ts` has why `0` would be a lie a `null` is not), and
 *   no rate to apply either (there is nothing to multiply).
 * - `pricing.rates[model]` priced, `measurement: 'measured'` — the ordinary
 *   case, a provider that reported usage against a model this table knows.
 * - A model missing from `pricing.rates` still gets priced, against
 *   `pricing.defaultRate` rather than costing zero (COST-6's own text:
 *   "a model with no known rate must not silently cost zero") —
 *   `measurement: 'estimated'`, since the number is a documented guess at
 *   what this model probably costs, not what the provider actually billed
 *   this specific model at.
 *
 * Integer micros throughout (D-2): `Math.round` at the very end, once, so
 * intermediate division never accumulates the fractional drift a ledger
 * exists to avoid.
 */
export function computeCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  pricing: PricingTable
): ComputedCost {
  if (!usage) {
    return {
      inputTokens: null,
      outputTokens: null,
      costMicros: 0,
      measurement: 'estimated',
    }
  }

  const knownRate = pricing.rates[model]
  const rate = knownRate ?? pricing.defaultRate
  const costMicros = Math.round(
    (usage.inputTokens * rate.inputMicrosPerMillionTokens) / 1_000_000 +
      (usage.outputTokens * rate.outputMicrosPerMillionTokens) / 1_000_000
  )

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicros,
    measurement: knownRate ? 'measured' : 'estimated',
  }
}
