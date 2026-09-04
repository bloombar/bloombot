/**
 * The Responses API request/response mapping — the part of the adapter that
 * builds the call `response_bot.py` makes (`response_bot.py:296-330`) and
 * reads what comes back.
 *
 * Nothing here does network I/O; `client.ts` owns the `fetch` call and the
 * retry around it, so this file stays a plain, synchronous, easily-tested
 * translation between `ModelRequest`/`ModelAnswer` (`@bloombot/core`'s port)
 * and the JSON shapes OpenAI's API actually uses.
 */

/** AI-4/`response_bot.py:328` — every request is bounded at the same 2048 tokens the running bot uses. */
export const MAX_OUTPUT_TOKENS = 2048

/** AI-4 — the platform default when a course has never configured its own model. */
export const DEFAULT_MODEL = 'gpt-4o'

/** What one Responses API call needs, already resolved from the port and the conversation the adapter is using for it. */
export interface BuildResponsesRequestInput {
  model: string
  /** MDL-2/D-3 — wins over `instructions` when set, matching the two courses running today. */
  promptId: string | null
  /** MDL-2/D-3 — used only when `promptId` is unset, the escape hatch a tenant without an OpenAI dashboard actually uses. */
  instructions: string | null
  /** MDL-3 — enables `file_search` against this store when set; omitted entirely otherwise. */
  vectorStoreId: string | null
  /**
   * MDL-9/FILE-6 — enables a `web_search` tool restricted to exactly these
   * domains when non-empty (WEB-31's own "restricted", never an
   * unrestricted search); omitted entirely when empty, the same "no tool
   * for nothing configured" treatment `vectorStoreId: null` already gets
   * for `file_search` — a course that names no websites is answered
   * exactly as before this shipped.
   */
  webSourceDomains: string[]
  /** MDL-4 — the upstream conversation this turn belongs to. */
  conversationId: string
  question: string
}

/** The JSON body `POST {baseUrl}/responses` is sent with. */
export interface ResponsesRequestBody {
  model: string
  input: Array<{ role: 'user'; content: string }>
  conversation: string
  max_output_tokens: number
  store: true
  prompt?: { id: string }
  instructions?: string
  tools?: Array<
    | { type: 'file_search'; vector_store_ids: string[] }
    | { type: 'web_search'; filters: { allowed_domains: string[] } }
  >
}

/**
 * Build the request body for one turn (MDL-2, MDL-3, MDL-5).
 *
 * Unlike `response_bot.py`, which always sends `prompt={"id": ...}` (even
 * `None`) and always sends the `file_search` tool (even with a `None`
 * store), this only sends `prompt` or `instructions` — whichever the course
 * actually has (D-3) — and only sends `tools` when there is a store to
 * search, so a course without one is answered without the tool rather than
 * with a call the API would reject (MDL-3's "refused" is the outcome this
 * avoids).
 */
export function buildResponsesRequestBody(
  input: BuildResponsesRequestInput
): ResponsesRequestBody {
  const body: ResponsesRequestBody = {
    model: input.model,
    input: [{ role: 'user', content: input.question }],
    conversation: input.conversationId,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: true,
  }

  // MDL-2/D-3 — the stored prompt wins over inline instructions when the
  // course has one; a course with only instructions sends them inline.
  if (input.promptId) {
    body.prompt = { id: input.promptId }
  } else if (input.instructions) {
    body.instructions = input.instructions
  }

  // MDL-3 — grounded in the course's own material when it has any.
  if (input.vectorStoreId) {
    body.tools = [
      ...(body.tools ?? []),
      { type: 'file_search', vector_store_ids: [input.vectorStoreId] },
    ]
  }

  // MDL-9/FILE-6 — grounded in the course's own named websites when it has
  // any, restricted to exactly that list (WEB-31) — never an unrestricted
  // `web_search`, and coexisting with `file_search` above in the same
  // array when a course has both a vector store and websites configured.
  if (input.webSourceDomains.length > 0) {
    body.tools = [
      ...(body.tools ?? []),
      {
        type: 'web_search',
        filters: { allowed_domains: input.webSourceDomains },
      },
    ]
  }

  return body
}

/** The `output` array shape the Responses API returns — a list of items, the ones this adapter cares about being assistant messages holding text parts. */
interface ResponsesOutputItem {
  type?: unknown
  content?: unknown
}

interface ResponsesOutputTextPart {
  type?: unknown
  text?: unknown
}

/** The usage object the Responses API reports, when it reports one at all. */
export interface ResponsesUsage {
  input_tokens?: unknown
  output_tokens?: unknown
}

/** What `POST {baseUrl}/responses` returns on success — only the fields this adapter reads. */
export interface ResponsesPayload {
  output?: unknown
  usage?: ResponsesUsage
}

/**
 * Pull the answer text out of a Responses API payload.
 *
 * The API returns an `output` array of items rather than a flat string —
 * the official SDK computes an `output_text` convenience property from it
 * client-side, which is what `response_bot.py`'s own `openai_response.output_text`
 * reads (it calls through the Python SDK, not raw HTTP). This adapter talks
 * HTTP directly (see `docs/DECISIONS.md`), so it does the same walk here:
 * every `message`-typed output item, every `output_text`-typed content part
 * of it, concatenated in order.
 */
export function extractOutputText(payload: ResponsesPayload): string {
  const output = Array.isArray(payload.output) ? payload.output : []
  const parts: string[] = []
  for (const item of output as ResponsesOutputItem[]) {
    if (item?.type !== 'message') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content as ResponsesOutputTextPart[]) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
  }
  return parts.join('')
}

// MDL-6 — `response_bot.py:325`'s own pattern (`re.sub(r"【.*?】", "", …)`),
// widened with the `s` flag so a marker whose content spans a newline is
// still removed: the requirement here is "never reach a student" (MDL-6's
// own title), not byte-for-byte fidelity to a regex that happens not to use
// `re.DOTALL`. See docs/DECISIONS.md.
const CITATION_MARKER_RE = /【.*?】/gs

/** Strip OpenAI's inline source markers (MDL-6) — called after the text has already been trimmed, matching `response_bot.py`'s own order (`.strip()` then the `re.sub`). */
export function stripCitationMarkers(text: string): string {
  return text.replace(CITATION_MARKER_RE, '')
}

/** Read the token counts off a Responses payload, when it reported any (MDL-5: "returned for the cost ledger to record"). `undefined` when the provider reported neither. */
export function extractUsage(
  payload: ResponsesPayload
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = payload.usage
  if (
    !usage ||
    typeof usage.input_tokens !== 'number' ||
    typeof usage.output_tokens !== 'number'
  ) {
    return undefined
  }
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
}
