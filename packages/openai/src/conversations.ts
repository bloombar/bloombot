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
 * `src/ports.ts`) carries `displayName`, `courseTitle` and `addressAs` —
 * added as one field, `personRef`, in finding 1 of the MDL-1 rework
 * (docs/DECISIONS.md, D-16), then split by CORE-7/CORE-8 into `addressAs`
 * (this file's own `buildSeedText`, below — content the model reads and
 * can echo into a reply) and `personIdentifier` (metadata only, genuinely
 * opaque — `ports.ts`'s own comment has the fuller reasoning for why the
 * split exists at all). `client.ts` threads both straight through from the
 * request it was given; this file still degrades gracefully when any
 * field is missing, for a caller (or a future surface) that genuinely does
 * not have one.
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
  /** CORE-7/CORE-8 — how the surface wants the model able to address the person, embedded in the opening item's own content. `null` addresses nobody. */
  addressAs: string | null
  /**
   * MDL-4 — the raw, opaque identity reference, carried in `metadata.
   * user_id` (the *field* matches `response_bot.py`'s own
   * `metadata={"user_id": ...}`; the *value* deliberately no longer does —
   * `ports.ts`'s own `ModelRequest.personIdentifier` comment has the fuller
   * "field matches, value doesn't, and that is a real discontinuity with a
   * legacy `user_id` lookup" reasoning, D-70), never in the opening item's
   * content. `null` omits `metadata` entirely.
   */
  personIdentifier: string | null
}

/**
 * The opening item's text (MDL-4's "seeded with who they are and which
 * course they are in"), matching `response_bot.py:262-269`'s own —
 * `"My name is {name} (user id {mention}) and I am a student in the
 * {course_name} course."`, where `{mention}` was Discord's own angle-bracket
 * mention token — when every field is known and the surface is Discord
 * (`addressAs` is that surface's own choice — CORE-7/CORE-8). Degrades
 * gracefully when any is missing rather than fabricating one: `addressAs`
 * only ever appears alongside a `displayName` (there is nothing to attach a
 * bare address to in prose), and a course title on its own drops the name
 * clause entirely.
 */
export function buildSeedText(
  displayName: string | null,
  courseTitle: string | null,
  addressAs: string | null
): string {
  const nameClause = displayName
    ? addressAs
      ? `My name is ${displayName} (user id ${addressAs})`
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
          options.addressAs
        ),
      },
    ],
  }
  // MDL-4 — sourced from `personIdentifier`, not `addressAs`: metadata is
  // never part of the content the model reads (`ports.ts`'s own comment on
  // the split), so this is the one place a raw identity is genuinely safe
  // to send, independent of whatever (if anything) the opening item above
  // addressed the person as.
  if (options.personIdentifier) {
    body.metadata = { user_id: options.personIdentifier }
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
