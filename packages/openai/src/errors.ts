/**
 * MDL-5's retry classification, and MDL-4's "the provider has forgotten this
 * conversation" case — kept in one place so `client.ts` never inspects an
 * HTTP status or an OpenAI error body itself.
 *
 * Two axes matter to the caller: whether a failure is worth retrying once
 * (a timeout, a rate limit, a 5xx — the kind that might succeed a moment
 * later) versus not (a refusal or a malformed request, which will fail
 * again for the same reason and only spends money doing it), and whether it
 * is specifically an unknown-conversation 404, which `client.ts` handles by
 * starting a new conversation rather than by retrying the same call.
 */

/** What kind of failure this was — `client.ts`'s retry and recreate logic branch on this, not on a raw HTTP status. */
export type ModelErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'server_error'
  | 'unknown_conversation'
  | 'client_error'

/**
 * A classified failure from a call to the OpenAI API. Carries the
 * provider's own message (`errors.ts`'s whole job is finding it), and
 * `retryable` precomputed from `kind` so a caller never has to re-derive
 * MDL-5's list of transient kinds itself.
 */
export class ModelRequestError extends Error {
  readonly kind: ModelErrorKind
  /** MDL-5 — a timeout, a rate limit or a 5xx is worth one retry; nothing else is. */
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(
    kind: ModelErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'ModelRequestError'
    this.kind = kind
    this.retryable =
      kind === 'timeout' || kind === 'rate_limit' || kind === 'server_error'
    this.status = options.status
  }
}

/** The shape an OpenAI error body takes: `{ error: { message, type, code, param } }`. */
interface OpenAiErrorBody {
  error?: {
    message?: unknown
    type?: unknown
    code?: unknown
    param?: unknown
  }
}

function isOpenAiErrorBody(value: unknown): value is OpenAiErrorBody {
  return typeof value === 'object' && value !== null && 'error' in value
}

/** The provider's own message, when the error body has the shape it usually does — a placeholder otherwise, so the log line is never empty. */
function extractMessage(body: unknown): string {
  if (isOpenAiErrorBody(body) && typeof body.error?.message === 'string') {
    return body.error.message
  }
  return 'OpenAI request failed with no error message in the response body'
}

/**
 * MDL-4 — the specific 404 that means "this conversation id is no longer
 * known to the provider", distinguished from every other 404 (a bad prompt
 * id, a bad vector store id) by the `error.code`/`error.param` OpenAI's own
 * API uses to name the conversation as the offending field. Any other 404
 * is an ordinary `client_error` — not retried, and not a reason to start a
 * new conversation.
 */
function isUnknownConversation(body: unknown): boolean {
  if (!isOpenAiErrorBody(body)) return false
  const { code, param } = body.error ?? {}
  return code === 'conversation_not_found' || param === 'conversation'
}

/**
 * Classify a non-2xx HTTP response into a `ModelRequestError`. This is the
 * one place a raw status code is read, so `responses.ts` and
 * `conversations.ts` only ever see the classified kind.
 */
export function classifyHttpError(
  status: number,
  body: unknown
): ModelRequestError {
  const message = extractMessage(body)
  if (status === 404 && isUnknownConversation(body)) {
    return new ModelRequestError('unknown_conversation', message, { status })
  }
  if (status === 429) {
    return new ModelRequestError('rate_limit', message, { status })
  }
  if (status >= 500) {
    return new ModelRequestError('server_error', message, { status })
  }
  return new ModelRequestError('client_error', message, { status })
}

/** A request that outlived its timeout (MDL-5) — abandoned, not left holding a student's reply open. */
export function timeoutError(
  timeoutMs: number,
  cause?: unknown
): ModelRequestError {
  return new ModelRequestError(
    'timeout',
    `OpenAI request did not complete within ${timeoutMs}ms`,
    { cause }
  )
}
