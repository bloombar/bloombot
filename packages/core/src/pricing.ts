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
 * COST-3/COST-6 rework finding 2 — used only when `usage` is `undefined`:
 * roughly how many characters make up one token, so a call the provider
 * reported no usage for still gets a real, nonzero estimate rather than
 * `costMicros: 0`. `0` there used to read as "this call was free," which is
 * false — real money was spent — and it is exactly what let the spending
 * cap (`hasReachedSpendingCap`, which sums this very column) stop counting
 * an organization's own unmetered calls forever. `4` is OpenAI's own
 * documented rule of thumb for English text ("a helpful rule of thumb is
 * that one token generally corresponds to ~4 characters of text for common
 * English text", `platform.openai.com/tokenizer`) — not exact, but a
 * defensible number the request and answer text already in hand can
 * produce, which `0` never was.
 */
const ESTIMATED_CHARACTERS_PER_TOKEN = 4

/** An estimated token count from a string's own length, rounded half up the same as `costMicros` itself (below) — a whole token is the smallest unit either side of `computeCost`'s arithmetic deals in. */
function estimateTokens(text: string): number {
  return Math.round(text.length / ESTIMATED_CHARACTERS_PER_TOKEN)
}

/**
 * Price one model call.
 *
 * - `usage` is `undefined` exactly when `@bloombot/openai`'s own
 *   `extractUsage` (MDL-5) found none to report — COST-6: recorded as an
 *   **estimate**, priced against `text`'s own character-based token
 *   estimate (`estimateTokens` above) rather than `costMicros: 0` (finding
 *   2 of this rework) — the request and answer text are always in hand,
 *   even when the provider's own usage is not, so there is something real
 *   to multiply after all.
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
 * exists to avoid — true of the estimated path above exactly as it already
 * was of the measured one, both routed through the same arithmetic below.
 */
export function computeCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  pricing: PricingTable,
  /** The question asked and the answer given, used only to estimate token counts when `usage` is `undefined` (finding 2 of this rework) — ignored entirely on the measured path. */
  text: { question: string; answer: string }
): ComputedCost {
  const measured = usage !== undefined
  const tokens = measured
    ? usage
    : {
        inputTokens: estimateTokens(text.question),
        outputTokens: estimateTokens(text.answer),
      }

  const knownRate = pricing.rates[model]
  const rate = knownRate ?? pricing.defaultRate
  const costMicros = Math.round(
    (tokens.inputTokens * rate.inputMicrosPerMillionTokens) / 1_000_000 +
      (tokens.outputTokens * rate.outputMicrosPerMillionTokens) / 1_000_000
  )

  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    costMicros,
    measurement: measured && knownRate ? 'measured' : 'estimated',
  }
}
