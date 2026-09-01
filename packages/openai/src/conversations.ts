/**
 * MDL-4 — the upstream conversation the platform remembers by
 * `conversations.upstreamThreadId` (`@bloombot/db`'s repo, not this
 * package's concern). This file only knows how to create one and how to
 * seed its opening item; `client.ts` decides when to call it (no stored id,
 * or a stored id the provider has forgotten).
 *
 * A gap this file cannot close on its own: `response_bot.py`'s opening item
 * seeds the conversation with the student's Discord name, their Discord id
 * and the course name (`response_bot.py:264-273`). `ModelRequest`
 * (`@bloombot/core`'s `src/ports.ts`) carries none of the three — only
 * `promptId`, `instructions`, `vectorStoreId`, `model`, `upstreamThreadId`
 * and `question` — and `answer.ts` does not pass them either. Per this
 * slice's brief ("do not change [the port's] shape; if it genuinely cannot
 * express something the adapter needs, stop and report rather than
 * widening it"), this function is written to seed a real name and course
 * title when it is given them — and is unit-tested doing so — but
 * `client.ts`'s own call to it, constrained to what `ModelRequest` actually
 * carries, cannot supply either today. See docs/DECISIONS.md and this
 * slice's report.
 */

import { classifyHttpError } from './errors.js'
import { postJson } from './http.js'

/** What `createUpstreamConversation` needs to talk to one request's worth of the Conversations API. */
export interface CreateUpstreamConversationOptions {
  fetchFn: typeof fetch
  baseUrl: string
  apiKey: string
  timeoutMs: number
  /** The person's display name, when the caller has it. `null` seeds a generic opening item instead. */
  displayName: string | null
  /** The course's title, when the caller has it. `null` for the same reason. */
  courseTitle: string | null
  /** Carried in `metadata.user_id`, matching `response_bot.py`'s own `metadata={"user_id": ...}` — `null` omits it. */
  personRef: string | null
}

/**
 * The opening item's text (MDL-4's "seeded with who they are and which
 * course they are in"). Degrades gracefully when either half is missing
 * rather than fabricating one — see this file's module comment for why
 * `client.ts` hits the last branch today.
 */
export function buildSeedText(
  displayName: string | null,
  courseTitle: string | null
): string {
  if (displayName && courseTitle) {
    return `My name is ${displayName} and I am a student in the ${courseTitle} course.`
  }
  if (courseTitle) {
    return `I am a student in the ${courseTitle} course.`
  }
  if (displayName) {
    return `My name is ${displayName}.`
  }
  return 'Starting a new conversation.'
}

/**
 * Create a new upstream conversation and return its id.
 *
 * Mirrors `openai_client.conversations.create(items=[...], metadata={...})`
 * (`response_bot.py:264-269`) over raw HTTP (see docs/DECISIONS.md for why
 * this package talks HTTP directly rather than through the `openai`
 * package).
 */
export async function createUpstreamConversation(
  options: CreateUpstreamConversationOptions
): Promise<string> {
  const body: {
    items: Array<{ role: 'user'; content: string }>
    metadata?: Record<string, string>
  } = {
    items: [
      {
        role: 'user',
        content: buildSeedText(options.displayName, options.courseTitle),
      },
    ],
  }
  if (options.personRef) {
    body.metadata = { user_id: options.personRef }
  }

  const response = await postJson('/conversations', body, options)
  if (!response.ok) {
    throw classifyHttpError(response.status, response.body)
  }
  const id = (response.body as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string') {
    throw new Error(
      'OpenAI conversations.create response had no string "id" field'
    )
  }
  return id
}
