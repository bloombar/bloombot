/**
 * MDL-4 — the upstream conversation the platform remembers by
 * `conversations.upstreamThreadId` (`@bloombot/db`'s repo, not this
 * package's concern). This file only knows how to create one and how to
 * seed its opening item; `client.ts` decides when to call it (no stored id,
 * or a stored id the provider has forgotten).
 *
 * `response_bot.py`'s opening item seeds the conversation with the
 * student's Discord name, their Discord id and the course name
 * (`response_bot.py:262-269`). `ModelRequest` (`@bloombot/core`'s
 * `src/ports.ts`) now carries all three — `displayName`, `courseTitle` and
 * `personRef` — added in finding 1 of the MDL-1 rework (docs/DECISIONS.md,
 * D-16) once `answer.ts` had somewhere to get a display name
 * (`people.getPerson`) and an identity reference (the new
 * `people.getPersonIdentity`) from. `client.ts` threads them straight
 * through from the request it was given; this file still degrades
 * gracefully when any of the three is missing, for a caller (or a future
 * surface) that genuinely does not have one.
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
 * course they are in"), matching `response_bot.py:262-269`'s own
 * `f"My name is {name} (user id <@{id}>) and I am a student in the
 * {course_name} course."` when every field is known. Degrades gracefully
 * when any is missing rather than fabricating one: `personRef` only ever
 * appears alongside a `displayName` (there is nothing to attach a bare
 * identity reference to in prose), and a course title on its own drops the
 * name clause entirely.
 */
export function buildSeedText(
  displayName: string | null,
  courseTitle: string | null,
  personRef: string | null
): string {
  const nameClause = displayName
    ? personRef
      ? `My name is ${displayName} (user id ${personRef})`
      : `My name is ${displayName}`
    : null

  if (nameClause && courseTitle) {
    return `${nameClause} and I am a student in the ${courseTitle} course.`
  }
  if (courseTitle) {
    return `I am a student in the ${courseTitle} course.`
  }
  if (nameClause) {
    return `${nameClause}.`
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
        content: buildSeedText(
          options.displayName,
          options.courseTitle,
          options.personRef
        ),
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
