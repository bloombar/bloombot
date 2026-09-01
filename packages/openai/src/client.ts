/**
 * MDL-1 — the only file in the platform that assembles a `ModelClient`
 * (`@bloombot/core`'s `src/ports.ts`) backed by OpenAI. `createOpenAiModelClient`
 * is a factory, not a module-level singleton (PLAT-5): constructing the
 * client is the only place the API key, base URL and timeout are read, and
 * nothing here runs until a caller actually calls it.
 *
 * `ask` is the whole port. In order:
 *  1. Resolve the upstream conversation (MDL-4) — reuse `request.upstreamThreadId`
 *     when set, or create one when it is not.
 *  2. Build and send the Responses API call (MDL-2, MDL-3, MDL-5's bound and
 *     retry-once), with one exception: a stored id the provider has
 *     forgotten (a 404 naming the conversation) creates a new conversation
 *     and retries the call exactly once more (MDL-4) — not folded into
 *     MDL-5's transient retry, which stays "the same call, once more".
 *  3. Extract, strip (MDL-6) and return the answer, the id `answer.ts`
 *     should persist (`null` when it reused an existing one), and the token
 *     counts (MDL-5) when the provider reported any.
 */

import type { ModelAnswer, ModelClient, ModelRequest } from '@bloombot/core'
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
  return response.body as ResponsesPayload
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
        // See conversations.ts's module comment: ModelRequest carries
        // neither a display name nor a course title today, so the opening
        // item is seeded generically rather than invented.
        conversationId = await createUpstreamConversation({
          ...httpOptions,
          displayName: null,
          courseTitle: null,
          personRef: null,
        })
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
        payload = await askOnceWithTransientRetry(body, httpOptions, logger)
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
          conversationId = await createUpstreamConversation({
            ...httpOptions,
            displayName: null,
            courseTitle: null,
            personRef: null,
          })
          newConversationId = conversationId
          body.conversation = conversationId
          payload = await askOnceWithTransientRetry(body, httpOptions, logger)
        } else {
          throw error
        }
      }

      // MDL-6 — trim first, then strip markers, matching response_bot.py's
      // own order (`.strip()` before the `re.sub`).
      const text = stripCitationMarkers(extractOutputText(payload).trim())
      const usage = extractUsage(payload)

      // `ModelAnswer.usage` (ports.ts) is optional, not
      // optional-or-`undefined` (`exactOptionalPropertyTypes`) — omitted
      // entirely rather than set to `undefined` when the provider reported
      // no usage.
      return usage
        ? { text, upstreamThreadId: newConversationId, usage }
        : { text, upstreamThreadId: newConversationId }
    },
  }
}

/** MDL-5 — one attempt, and a transient failure (timeout, 429, 5xx) is retried exactly once; a refusal or an invalid request is not. */
async function askOnceWithTransientRetry(
  body: ReturnType<typeof buildResponsesRequestBody>,
  httpOptions: HttpOptions,
  logger: Logger
): Promise<ResponsesPayload> {
  try {
    return await postResponses(body, httpOptions)
  } catch (error) {
    if (error instanceof ModelRequestError && error.retryable) {
      logger.warn(
        { err: error, kind: error.kind },
        'openai: retrying once after a transient failure'
      )
      return await postResponses(body, httpOptions)
    }
    throw error
  }
}
