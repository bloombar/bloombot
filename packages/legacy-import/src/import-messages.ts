/**
 * MIG-3's second half: each legacy `messages` row becomes a message on the
 * (course, person) conversation.
 *
 * Course routing matches `response_bot.py#find_course_by_category` exactly:
 * the legacy row's `category` (a Discord category name) is looked up
 * against the categories the *imported* courses declare, and the first
 * course whose `categories` list contains it wins — `response_bot.py` never
 * falls back to role-based routing (`find_course_by_roles`) for a message
 * already logged with a category, so this importer does not either. A
 * category matching no course, or a `user_id` this snapshot's people import
 * could not place, is reported in `unplaceable` rather than dropped (MIG-4)
 * — a transcript row that silently vanished on import would be exactly the
 * kind of "useless as the record it exists to be" MIG-3 rules out.
 *
 * `direction` maps `from` (student to bot) to `from_person`, and `to` (bot
 * to student) to `to_person` — `messages.direction`'s own two values
 * (`schema.ts`).
 */

import {
  conversations as conversationsRepo,
  courses as coursesRepo,
  type Database,
} from '@bloombot/db'

import { deterministicId } from './ids.js'
import { parseLegacyTimestamp, type LegacyMessage } from './read-legacy.js'

/** A message that could not be placed on any conversation, and why. */
export interface UnplaceableMessage {
  legacyMessageId: number
  reason: string
}

/** What `importMessages` created, matched, or could not place. */
export interface ImportMessagesResult {
  created: number
  matched: number
  unplaceable: UnplaceableMessage[]
}

/** The courses this run imported (or matched), with enough of their shape to route by category. */
export interface RoutableCourse {
  id: string
  categoryNames: string[]
}

/** A flat `category name -> course id` map — PROJ-3 guarantees a category name is unique across an organization's enabled courses, so this map is safe to build once. */
function buildCategoryIndex(courses: RoutableCourse[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const course of courses) {
    for (const categoryName of course.categoryNames) {
      index.set(categoryName, course.id)
    }
  }
  return index
}

/**
 * Import `legacyMessages` (already ordered oldest-first by
 * `read-legacy.ts#readLegacyMessages`) into `organizationId`.
 *
 * `personByLegacyUserId` is `import-people.ts`'s output, keyed by the
 * legacy `users.id` each message's `user_id` refers to — this file never
 * re-derives a person from a Discord id itself, so the two importers stay
 * decoupled from each other's lookup strategy.
 *
 * Idempotent (MIG-4) through a deterministic id, `legacy-message-<hash of
 * organizationId and the legacy row's own id>` — messages have no natural
 * key of their own to match on (unlike a course's title or a person's
 * Discord identity), so a caller-generated id is what lets a re-run
 * recognise "this row is already here" instead of appending a duplicate.
 * Checked against each conversation's own transcript, read once per
 * conversation and cached for the rest of this run, so importing N messages
 * costs one transcript read per distinct conversation, not N.
 */
export function importMessages(
  organizationId: string,
  legacyMessages: LegacyMessage[],
  personByLegacyUserId: Map<number, string>,
  courses: RoutableCourse[],
  db: Database
): ImportMessagesResult {
  const categoryIndex = buildCategoryIndex(courses)
  const transcriptIdsByConversation = new Map<string, Set<string>>()

  let created = 0
  let matched = 0
  const unplaceable: UnplaceableMessage[] = []

  for (const legacyMessage of legacyMessages) {
    const courseId = categoryIndex.get(legacyMessage.category)
    const personId = personByLegacyUserId.get(legacyMessage.userId)

    if (!courseId) {
      unplaceable.push({
        legacyMessageId: legacyMessage.id,
        reason: `No imported course declares category '${legacyMessage.category}'.`,
      })
      continue
    }
    if (!personId) {
      unplaceable.push({
        legacyMessageId: legacyMessage.id,
        reason: `The person for legacy user ${legacyMessage.userId} could not be imported.`,
      })
      continue
    }

    const conversation = conversationsRepo.getOrCreateConversation(
      organizationId,
      { courseId, personId, surface: 'discord' },
      db
    )
    if (!conversation) {
      // Cannot happen for a course/person this same run just resolved, both
      // scoped to `organizationId` — kept as a reported outcome rather than
      // an assertion, the same "never drop silently" MIG-4 asks of every
      // other refusal in this file.
      unplaceable.push({
        legacyMessageId: legacyMessage.id,
        reason: `Could not open a conversation for course ${courseId} and person ${personId}.`,
      })
      continue
    }

    let seenIds = transcriptIdsByConversation.get(conversation.id)
    if (!seenIds) {
      seenIds = new Set(
        conversationsRepo
          .getTranscript(organizationId, conversation.id, db)
          .map((message) => message.id)
      )
      transcriptIdsByConversation.set(conversation.id, seenIds)
    }

    const messageId = deterministicId(
      'legacy-message',
      organizationId,
      String(legacyMessage.id)
    )
    if (seenIds.has(messageId)) {
      matched += 1
      continue
    }

    conversationsRepo.appendMessage(
      organizationId,
      conversation.id,
      {
        id: messageId,
        direction:
          legacyMessage.direction === 'from' ? 'from_person' : 'to_person',
        content: legacyMessage.content,
        surface: 'discord',
        channelRef: legacyMessage.channel,
        categoryRef: legacyMessage.category,
        createdAt: parseLegacyTimestamp(legacyMessage.createdAt),
      },
      db
    )
    seenIds.add(messageId)
    created += 1
  }

  return { created, matched, unplaceable }
}

/** Build `RoutableCourse[]` from a set of course ids, reading each course's categories back through the repos (never the importer's own return value — the same principle the tests hold the importer to). */
export function loadRoutableCourses(
  organizationId: string,
  courseIds: string[],
  db: Database
): RoutableCourse[] {
  return courseIds.flatMap((courseId) => {
    const course = coursesRepo.getCourse(organizationId, courseId, db)
    if (!course) return []
    return [
      {
        id: course.id,
        categoryNames: course.categories.map((category) => category.name),
      },
    ]
  })
}
