/**
 * The one place a `fetch` call is actually made.
 *
 * `conversations.ts` and `client.ts` (for the Responses API call) both go
 * through this rather than each re-implementing the abort/parse dance —
 * timeout via `AbortController`, JSON in and out, and the OpenAI bearer
 * header shape. Each call gets its own fresh `timeoutMs` window (see
 * docs/DECISIONS.md's "the retry applies per attempt, not to a shared
 * budget" for why that is the adapter's choice, not an accident).
 */

import { timeoutError } from './errors.js'

export interface PostJsonOptions {
  fetchFn: typeof fetch
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

export interface JsonResponse {
  status: number
  ok: boolean
  body: unknown
}

/** Finding 7 of the MDL-1 rework — a `baseUrl` with a trailing slash (`OPENAI_BASE_URL`'s real-world default plus a trailing `/`, valid per the config schema's `z.url()` and the form half the world writes) naively concatenated with a leading-slash `path` produces a doubled slash the API 404s on. One or more trailing slashes are stripped so every call lands on the right path regardless of which spelling the caller configured. */
function stripTrailingSlashes(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * POST a JSON body to `${baseUrl}${path}` with the OpenAI bearer header,
 * and parse whatever comes back as JSON.
 *
 * Never throws for a non-2xx status — `errors.ts`'s `classifyHttpError`
 * turns that into the caller's problem to classify, not this function's.
 * Throws only for a timeout (MDL-5, wrapped as a classified
 * `ModelRequestError`) or a genuine transport failure `fetch` itself threw.
 */
export async function postJson(
  path: string,
  requestBody: unknown,
  options: PostJsonOptions
): Promise<JsonResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  // Finding 2 of the MDL-1 rework — the timer stays armed across the body
  // read too, not just the initial `fetch`: headers arriving is not the
  // whole response, and a body that stalls after them must still be bound
  // by `timeoutMs`, not by whatever default the runtime's own `fetch`
  // falls back to once nothing here is watching (undici's own default is
  // five minutes). `clearTimeout` only runs once, in this `finally`, after
  // both steps have either succeeded or thrown.
  try {
    let response: Response
    try {
      response = await options.fetchFn(
        `${stripTrailingSlashes(options.baseUrl)}${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }
      )
    } catch (error) {
      // An abort we asked for ourselves is a timeout (MDL-5); any other
      // rejection (DNS failure, connection refused, …) is a genuine
      // transport error and is rethrown as-is rather than misclassified.
      if (controller.signal.aborted) {
        throw timeoutError(options.timeoutMs, error)
      }
      throw error
    }

    let body: unknown
    try {
      body = await parseJsonBody(response)
    } catch (error) {
      // The same abort can now land here instead — the response's headers
      // arrived before the timeout, but its body stalled after them.
      if (controller.signal.aborted) {
        throw timeoutError(options.timeoutMs, error)
      }
      throw error
    }
    return { status: response.status, ok: response.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

/** `response.text()` then `JSON.parse`, tolerant of an empty or non-JSON body — an error response is still worth classifying even when it is not valid JSON. */
async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text } }
  }
}
