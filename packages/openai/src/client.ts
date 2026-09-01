/**
 * MDL-1 — the only file in the platform that assembles a `ModelClient`
 * (`@bloombot/core`'s `src/ports.ts`) backed by OpenAI. `createOpenAiModelClient`
 * is a factory, not a module-level singleton (PLAT-5): constructing the
 * client is the only place the API key, base URL and timeout are read, and
 * nothing here runs until a caller actually calls it.
 *
 * `ask` is the whole port. In order:
 *  1. Resolve the upstream conversation (MDL-4) — reuse `request.upstreamThreadId`
 *     when set, or create one when it is not, seeded with whatever of
 *     `displayName`/`courseTitle`/`personRef` the request carries (finding 1
 *     of the MDL-1 rework). Both the create call and the answer call get
 *     MDL-5's transient retry (finding 3) — a 429 or 5xx on either is worth
 *     one retry, not just on the answer half.
 *  2. Build and send the Responses API call (MDL-2, MDL-3, MDL-5's bound and
 *     retry-once), with one exception: a stored id the provider has
 *     forgotten (a 404 naming the conversation) creates a new conversation
 *     and retries the call exactly once more (MDL-4) — not folded into
 *     MDL-5's transient retry, which stays "the same call, once more". Any
 *     failure from here on that happened *after* a new conversation id was
 *     minted is thrown as a `ModelAskError` (`@bloombot/core`'s `ports.ts`)
 *     carrying that id, so `answer.ts` can still persist it (finding 6) —
 *     a failed turn must not orphan the conversation it started.
 *  3. Extract, strip (MDL-6) and return the answer, the id `answer.ts`
 *     should persist (`null` when it reused an existing one), and the token
 *     counts (MDL-5) when the provider reported any. An answer that extracts
 *     to no text at all — a refusal, or a `status: "failed"` payload — is a
 *     failed turn too (finding 5), not a blank reply.
 */

import {
  ModelAskError,
  type ModelAnswer,
  type ModelClient,
  type ModelRequest,
} from '@bloombot/core'
import type { Logger } from '@bloombot/logger'
import { CONFIG } from '@bloombot/config'

import { createUpstreamConversation } from './conversations.js'
import { classifyHttpError, ModelRequestError } from './errors.js'
import { postJson } from './http.js'
import {
  buildResponsesRequestBody,
  DEFAULT_MODEL,
  extractOutputText,
  extractUsage,
  stripCitationMarkers,
  type ResponsesPayload,
} from './responses.js'

/** The four fields every OpenAI HTTP call needs — resolved once in `createOpenAiModelClient` and threaded into every helper below rather than re-read from `CONFIG` per call. */
type HttpOptions = Required<
  Pick<
    CreateOpenAiModelClientOptions,
    'baseUrl' | 'apiKey' | 'timeoutMs' | 'fetchFn'
  >
>

/** What building an OpenAI-backed `ModelClient` needs. */
export interface CreateOpenAiModelClientOptions {
  /** The OpenAI API key. Never logged, never defaulted — a missing key is the caller's mistake to surface, not this adapter's to guess at. */
  apiKey: string
  /** Defaults to `CONFIG.OPENAI_BASE_URL` (QA-2) — read here, at construction, not at module load (PLAT-5). */
  baseUrl?: string
  /** MDL-5's bound on how long one attempt may take. Defaults to 30s. */
  timeoutMs?: number
  logger: Logger
  /** Defaults to the global `fetch` — overridable so a test (or a future non-Node runtime) can supply its own. */
  fetchFn?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 30_000

/** POST the Responses API call once, with no retry of its own — retries are `ask`'s decision, not this helper's, since the two retry reasons (MDL-4's recreate, MDL-5's transient retry) branch differently. */
async function postResponses(
  body: ReturnType<typeof buildResponsesRequestBody>,
  options: HttpOptions
): Promise<ResponsesPayload> {
  const response = await postJson('/responses', body, options)
  if (!response.ok) {
    throw classifyHttpError(response.status, response.body)
  }
  // Finding 4 — a 2xx with an empty (or non-JSON) body has no usable
  // payload; casting it straight through left `extractOutputText` throwing
  // a raw, unclassified `TypeError` on `payload.output`. Classified here
  // instead, the same way `conversations.ts`'s own id check refuses to let
  // a malformed success response through un-checked.
  if (typeof response.body !== 'object' || response.body === null) {
    throw new ModelRequestError(
      'client_error',
      'OpenAI responses.create returned a 2xx response with no usable JSON body'
    )
  }
  return response.body as ResponsesPayload
}

/** MDL-5 — one attempt, and a transient failure (timeout, 429, 5xx) is retried exactly once; a refusal or an invalid request is not. Generic over what is being attempted (finding 3 of the MDL-1 rework: this now also wraps `createUpstreamConversation`, not just the answer call) — the retry policy is "the same call, once more" regardless of which request it is. */
async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  logger: Logger
): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (error instanceof ModelRequestError && error.retryable) {
      logger.warn(
        { err: error, kind: error.kind },
        'openai: retrying once after a transient failure'
      )
      return await attempt()
    }
    throw error
  }
}

/**
 * Finding 6 of the MDL-1 rework — wrap a failure with whatever new upstream
 * conversation id this call already minted, so `answer.ts` can still
 * persist it before taking the apology path. Passed straight through,
 * unwrapped, when nothing new was created (nothing for `answer.ts` to
 * persist beyond what it already has).
 */
function failWithNewConversation(
  error: unknown,
  newConversationId: string | null
): never {
  if (!newConversationId) {
    throw error
  }
  throw new ModelAskError(
    error instanceof Error ? error.message : String(error),
    newConversationId,
    { cause: error }
  )
}

/** Build a `ModelClient` (`@bloombot/core`'s port) backed by the OpenAI Responses API. */
export function createOpenAiModelClient(
  options: CreateOpenAiModelClientOptions
): ModelClient {
  const baseUrl = options.baseUrl ?? CONFIG.OPENAI_BASE_URL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch
  const { apiKey, logger } = options

  const httpOptions = { baseUrl, apiKey, timeoutMs, fetchFn }

  /** The one place `createUpstreamConversation` is called from — always through the same transient retry the answer call gets (finding 3), always seeded from this request's own fields (finding 1). */
  function createConversation(request: ModelRequest): Promise<string> {
    return withTransientRetry(
      () =>
        createUpstreamConversation({
          ...httpOptions,
          displayName: request.displayName,
          courseTitle: request.courseTitle,
          personRef: request.personRef,
        }),
      logger
    )
  }

  return {
    async ask(request: ModelRequest): Promise<ModelAnswer> {
      const model = request.model ?? DEFAULT_MODEL // AI-4

      // MDL-4 — reuse a stored id with no create call; create one on a
      // first turn. `newConversationId` is what `answer.ts` should persist
      // — `null` means "unchanged", matching `ModelAnswer.upstreamThreadId`'s
      // own contract in ports.ts.
      let conversationId = request.upstreamThreadId
      let newConversationId: string | null = null
      if (!conversationId) {
        conversationId = await createConversation(request)
        newConversationId = conversationId
      }

      const body = buildResponsesRequestBody({
        model,
        promptId: request.promptId,
        instructions: request.instructions,
        vectorStoreId: request.vectorStoreId,
        conversationId,
        question: request.question,
      })

      let payload: ResponsesPayload
      try {
        payload = await withTransientRetry(
          () => postResponses(body, httpOptions),
          logger
        )
      } catch (error) {
        // MDL-4 — the provider no longer recognizes the stored id: create a
        // new conversation and retry the call exactly once more, never in
        // a loop. Only reachable when `conversationId` was reused, not
        // freshly created — a 404 on a conversation this call just created
        // would be a provider bug, not one this adapter papers over.
        if (
          error instanceof ModelRequestError &&
          error.kind === 'unknown_conversation' &&
          newConversationId === null
        ) {
          logger.warn(
            { err: error, forgottenConversationId: conversationId },
            'openai: stored conversation id was rejected as unknown, starting a new one'
          )
          // The recreate's own create call failing leaves nothing new for
          // finding 6 to preserve — propagated as-is.
          conversationId = await createConversation(request)
          newConversationId = conversationId
          body.conversation = conversationId
          try {
            payload = await withTransientRetry(
              () => postResponses(body, httpOptions),
              logger
            )
          } catch (secondError) {
            // Finding 6 — the recreate succeeded even though the answer
            // didn't: the id it just minted must not be lost.
            failWithNewConversation(secondError, newConversationId)
          }
        } else {
          // Finding 6 — a plain transient failure (or a classified empty
          // body, finding 4) on a first turn: the conversation this call
          // just created, if any, is still real even though the answer
          // isn't.
          failWithNewConversation(error, newConversationId)
        }
      }

      // MDL-6 — trim first, then strip markers, matching response_bot.py's
      // own order (`.strip()` before the `re.sub`).
      const text = stripCitationMarkers(extractOutputText(payload).trim())

      // Finding 5 — a refusal content part, or a 200 whose payload is
      // `status: "failed"`, extracts to an empty string. Returning that as
      // a successful `ModelAnswer` would hand the student a blank reply;
      // `answer.ts` only takes the apology path on a thrown error, so this
      // is thrown too, carrying the same new-conversation id (if any) as
      // every other failure above.
      if (!text) {
        failWithNewConversation(
          new Error('OpenAI responses.create returned no answer text'),
          newConversationId
        )
      }

      const usage = extractUsage(payload)

      // `ModelAnswer.usage` (ports.ts) is optional, not
      // optional-or-`undefined` (`exactOptionalPropertyTypes`) — omitted
      // entirely rather than set to `undefined` when the provider reported
      // no usage. `model` (COST-1) is always this call's own resolved
      // model — `request.model ?? DEFAULT_MODEL`, computed once above —
      // never `request.model` itself, which is `null` on exactly the calls
      // this adapter had to fall back for.
      return usage
        ? { text, upstreamThreadId: newConversationId, model, usage }
        : { text, upstreamThreadId: newConversationId, model }
    },
  }
}
