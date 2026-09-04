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
  /**
   * MDL-9/FILE-6 — the bare domains a course's own `course_web_sources`
   * names (`@bloombot/db`'s repo of the same name), already normalized
   * (WEB-31) by whichever action added them — this field is never
   * responsible for reducing a domain to its bare form itself, only for
   * carrying the list an adapter turns into a domain-restricted
   * `web_search` tool (`@bloombot/openai`'s own `responses.ts`). Empty
   * (`[]`), never `null`: unlike `vectorStoreId`, which distinguishes "a
   * course has one" from "a course has none" with `string | null`, a
   * course's websites are inherently a list, and "no websites configured"
   * is naturally an empty one rather than a second sentinel meaning the
   * same thing — an adapter reads `webSourceDomains.length === 0` the same
   * way it already reads `vectorStoreId === null`: omit the tool entirely,
   * never send an unrestricted search.
   */
  webSourceDomains: string[]
  /** The course's configured model name (`courses.model`), or `null` to let the adapter fall back to its own default. */
  model: string | null
  /** The conversation's upstream model thread id (`conversations.upstreamThreadId`), or `null` on its first turn. */
  upstreamThreadId: string | null
  /** The question text, already cleaned of any surface-specific formatting (mention rewriting, etc.) by the caller. */
  question: string
  /**
   * The person's display name, when known — seeds a new upstream
   * conversation's opening item the way `response_bot.py` does
   * (`response_bot.py:262-269`, MDL-4). `null` when the person has none yet
   * (no roster import has merged one onto them).
   */
  displayName: string | null
  /**
   * The course's own title, for the same opening item. `answer.ts` already
   * has `course.title` in hand for the apology text (CORE-5), so this is
   * never `null` from that call site in practice — kept nullable here so an
   * adapter's own degradation (a generic opener) is still exercised by a
   * caller that genuinely has none.
   */
  courseTitle: string | null
  /**
   * CORE-7/CORE-8 — this used to be one field, `personRef`, documented as
   * "an opaque reference to the person" while actually holding Discord's
   * own angle-bracket mention token, built by wrapping the identity's id
   * inside this package — the one package meant to know nothing about any
   * surface. That was wrong on every surface but Discord: on the web, the
   * identity is the account's own id, so a student was answered with the
   * Discord token wrapped around a raw UUID. Split in two here, so each
   * half can actually be what its own name claims:
   *
   * `personIdentifier` is the genuinely opaque half — `person_identities.
   * externalId` on this request's surface, embedded only in the upstream
   * conversation's own metadata (`{"user_id": ...}`, MDL-4), never in
   * content a later turn's model call reads back. Nothing in this platform
   * (or the model) interprets it; it exists so a later transcript read — an
   * operator on the provider's own dashboard, not a person this platform
   * answers — can trace a stored conversation back to the identity that
   * opened it. `null` when the person has no identity on this request's
   * surface.
   *
   * The *field* matches `response_bot.py`'s own `metadata={"user_id": ...}`;
   * the *value* deliberately no longer does (D-70, docs/DECISIONS.md).
   * `response_bot.py:269` sent Discord's own mention token, angle brackets
   * and all, as that value; this sends the bare identity, unwrapped, on
   * every surface including Discord — the raw form is the more useful
   * metadata value (it is never rendered to anyone, so there is nothing
   * wrapping it for), but it is a real discontinuity: an operator filtering
   * the provider's own dashboard by a legacy, mention-shaped `user_id` will
   * not match a conversation created from this slice on.
   */
  personIdentifier: string | null
  /**
   * The other half of what `personRef` used to be: how the surface that
   * asked this question wants the model able to address the person,
   * embedded in the opening item's own content alongside `displayName`
   * (MDL-4) — content the model reads, and can echo back into a reply,
   * which is exactly how Discord's mention ends up rendered in one and a
   * raw UUID ended up leaking into the other. `answer.ts` no longer decides
   * this itself (CORE-7): the calling surface does, through
   * `AnswerDependencies.addressPerson`, and CORE-8 orders the choice —
   * Discord supplies its own mention token; a surface with none of its own
   * falls back through a first name, then a display name, then nothing at
   * all, never this platform's own id, the mistake this field replaces.
   * `null` when the surface addresses nobody, or has nothing to address
   * them with.
   */
  addressAs: string | null
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
  /**
   * The model this call actually ran against — COST-1's "every call
   * records ... the model", read back here rather than assumed from
   * `ModelRequest.model`: that field is `null` whenever a course leaves it
   * unconfigured (D-3), and it is the *adapter*'s business which concrete
   * model a `null` falls back to (`@bloombot/openai`'s own `DEFAULT_MODEL`,
   * this file's own module comment on `ModelRequest.model`) — `answer.ts`
   * must not guess at that fallback itself just to price the call.
   */
  model: string
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

/**
 * Thrown by `ModelClient.ask` when a turn fails *after* the adapter already
 * created a new upstream conversation for it (MDL-4's "no stored id" or
 * "stored id forgotten" paths) — finding 6 of the MDL-1 rework. A plain
 * thrown error loses that id: `answer.ts` only persists
 * `ModelAnswer.upstreamThreadId`, which a failed call never returns, so the
 * platform keeps pointing at whichever id it already had (`null`, or a
 * stale one the provider just rejected) and the next turn repeats the same
 * create-then-fail dance. This carries the id across the throw so
 * `answer.ts` can persist it before taking the apology path — the
 * conversation the adapter started is real even though this turn's answer
 * is not.
 *
 * Defined here rather than in `@bloombot/openai` because `answer.ts` must
 * never import a vendor package (CORE-4, this file's own module comment) —
 * an adapter that wants this behaviour throws this port's own error type,
 * not one of its own.
 */
export class ModelAskError extends Error {
  /** The upstream conversation id the failed call had already created. */
  readonly upstreamThreadId: string

  constructor(
    message: string,
    upstreamThreadId: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options)
    this.name = 'ModelAskError'
    this.upstreamThreadId = upstreamThreadId
  }
}
