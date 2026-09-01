/**
 * The two shapes of request this package makes — a form-encoded `POST` (the
 * OAuth token exchange, which Discord requires as
 * `application/x-www-form-urlencoded`, not JSON) and a `GET` with a bearer
 * header (the two guild-list reads) — plus the timeout/abort dance
 * `@bloombot/openai`'s own `http.ts` already established for this repo:
 * every call gets its own `AbortController` window, and an abort this
 * process asked for itself is classified as a timeout rather than left to
 * look like a generic transport failure.
 *
 * Every caller passes its own `baseUrl` in (`client.ts` reads it from
 * `CONFIG.DISCORD_API_BASE`/`CONFIG.DISCORD_OAUTH_BASE`, never this file) —
 * QA-2's "no vendor host hardcoded in a client", proven by
 * `tests/no-vendor-hostname.test.ts`.
 */

export interface RequestOptions {
  fetchFn: typeof fetch
  timeoutMs: number
}

export interface JsonResponse {
  status: number
  ok: boolean
  body: unknown
}

/** Thrown only for a timeout or a genuine transport failure — a non-2xx response is returned, not thrown, the same split `@bloombot/openai`'s `http.ts` uses so each caller classifies its own upstream failures. */
export class DiscordTransportError extends Error {
  readonly timedOut: boolean

  constructor(
    message: string,
    timedOut: boolean,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'DiscordTransportError'
    this.timedOut = timedOut
  }
}

async function runFetch(
  input: string,
  init: RequestInit,
  options: RequestOptions
): Promise<JsonResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    let response: Response
    try {
      response = await options.fetchFn(input, {
        ...init,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DiscordTransportError(
          `Discord request timed out after ${options.timeoutMs}ms`,
          true,
          { cause: error }
        )
      }
      throw new DiscordTransportError(
        'Discord request failed before a response arrived',
        false,
        { cause: error }
      )
    }

    let body: unknown
    try {
      body = await parseJsonBody(response)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DiscordTransportError(
          `Discord request timed out after ${options.timeoutMs}ms`,
          true,
          { cause: error }
        )
      }
      throw error
    }
    return { status: response.status, ok: response.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

/** `response.text()` then `JSON.parse`, tolerant of an empty or non-JSON body — the same tolerance `@bloombot/openai`'s own `parseJsonBody` gives an error response that is not valid JSON. */
async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

/** `POST` a form-encoded body — the OAuth token endpoint's own required content type (RFC 6749 §4.1.3), not JSON. */
export async function postForm(
  url: string,
  form: Record<string, string>,
  options: RequestOptions
): Promise<JsonResponse> {
  return runFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    options
  )
}

/** `GET` with an `Authorization` header — `client.ts` builds the header value itself (`Bearer <token>` for the user, `Bot <token>` for the bot), since only it knows which kind of token a given call carries. */
export async function getJson(
  url: string,
  authorization: string,
  options: RequestOptions
): Promise<JsonResponse> {
  return runFetch(
    url,
    { method: 'GET', headers: { Authorization: authorization } },
    options
  )
}

/** `POST` a JSON body with an `Authorization` header — SRV-6's guild-write calls (`client.ts`'s `createGuildCategory`/`createGuildChannel`), which Discord requires as `application/json`, unlike the OAuth token endpoint's form encoding `postForm` above exists for. */
export async function postJson(
  url: string,
  authorization: string,
  body: unknown,
  options: RequestOptions
): Promise<JsonResponse> {
  return runFetch(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify(body),
    },
    options
  )
}
