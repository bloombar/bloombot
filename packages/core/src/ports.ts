/**
 * The model port (CORE-4).
 *
 * `answer.ts` depends on this interface alone — never on an OpenAI (or any
 * other vendor) SDK type. That is what lets the whole pipeline run in tests
 * against a fake with no network (`tests/helpers/fake-model-client.ts`), and
 * what makes a second model provider an adapter implementing `ModelClient`
 * rather than a rewrite of the pipeline itself. Keep this file honest: no
 * Discord types, no OpenAI types, nothing vendor-shaped.
 */

/**
 * What a course contributes to one call to the model, plus the question
 * itself and the conversation's own continuity.
 *
 * `promptId` and `instructions` are both carried through rather than
 * resolved here (D-3): `courses.promptId` is the escape hatch that wins when
 * set, but *which one wins* is the adapter's business, not this port's — the
 * port stays a plain description of "what the course says to answer with",
 * and an adapter translates that into whichever call shape its own vendor
 * API wants (a stored prompt reference, or inline instructions text).
 */
export interface ModelRequest {
  /** The course's stored prompt id (`courses.promptId`), or `null` when it has none. Wins over `instructions` when set (D-3). */
  promptId: string | null
  /** The course's inline instructions (`courses.instructions`), or `null` when it has none. Used only when `promptId` is unset. */
  instructions: string | null
  /** The course's configured vector store (`courses.vectorStoreId`), or `null` when it has none. */
  vectorStoreId: string | null
  /** The course's configured model name (`courses.model`), or `null` to let the adapter fall back to its own default. */
  model: string | null
  /** The conversation's upstream model thread id (`conversations.upstreamThreadId`), or `null` on its first turn. */
  upstreamThreadId: string | null
  /** The question text, already cleaned of any surface-specific formatting (mention rewriting, etc.) by the caller. */
  question: string
}

/**
 * What a model call returns: the answer text, plus whatever the adapter
 * needs `answer.ts` to persist on its behalf.
 */
export interface ModelAnswer {
  /** The model's answer, ready to record and return — citation markers and the like are the adapter's concern, not this port's. */
  text: string
  /** A new (or changed) upstream thread id, when the adapter's call produced one. `null` when the conversation's existing id is unchanged. */
  upstreamThreadId: string | null
  /** Token counts, when the adapter's provider reports them. `undefined` when it does not — this port does not require every adapter to know. */
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * The port itself: a question and its context in, an answer out. One
 * method, because that is all `answer.ts` ever needs from a model provider.
 */
export interface ModelClient {
  ask(request: ModelRequest): Promise<ModelAnswer>
}
