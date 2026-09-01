/**
 * MIG-3's second half: each legacy `messages` row becomes a message on the
 * (course, person) conversation.
 *
 * Course routing matches `response_bot.py#find_course_by_category`: the
 * legacy row's `category` (a Discord category name) is looked up against the
 * categories the *imported* courses declare, and the first course (in
 * `routableCourses`'s own order) whose `categories` list contains it wins —
 * the same "first match" `find_course_by_category` itself uses. Unlike
 * `response_bot.py`, this importer does *not* fall back to role-based
 * routing (`find_course_by_roles`, `response_bot.py:183-187`) when the
 * category lookup fails: a legacy Discord role assignment is not part of
 * this snapshot, so there is nothing here to run that fallback against. That
 * is a real, defensible gap, not a bug — but it does mean some messages the
 * legacy bot *did* answer (because a category match failed and a role match
 * then succeeded) are reported `unplaceable` here rather than imported. A
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

/**
 * A category name two different courses both declare — PROJ-3 normally
 * refuses this at save time, so seeing one here means something upstream let
 * it through (a course saved into an archived project, whose PROJ-3 check is
 * skipped — `repos/courses.ts`). `courseId` is the course routing actually
 * used (the first to claim the name); `ignoredCourseId` is the one that lost.
 */
export interface DuplicateCategory {
  categoryName: string
  courseId: string
  ignoredCourseId: string
}

/** What `importMessages` created, matched, or could not place. */
export interface ImportMessagesResult {
  created: number
  matched: number
  unplaceable: UnplaceableMessage[]
  duplicateCategories: DuplicateCategory[]
}

/** The courses this run imported (or matched), with enough of their shape to route by category. */
export interface RoutableCourse {
  id: string
  categoryNames: string[]
}

/**
 * A flat `category name -> course id` map, plus any duplicate a course
 * later in `courses` tried to claim.
 *
 * The *first* course (in `courses`'s own order) whose list contains a
 * category name wins — matching `response_bot.py#find_course_by_category`'s
 * own "first match" behaviour (see this file's module comment) — so a later
 * course's `index.set` for an already-claimed name is skipped, not applied,
 * and recorded in `duplicates` rather than resolved silently.
 */
function buildCategoryIndex(courses: RoutableCourse[]): {
  index: Map<string, string>
  duplicates: DuplicateCategory[]
} {
  const index = new Map<string, string>()
  const duplicates: DuplicateCategory[] = []
  for (const course of courses) {
    for (const categoryName of course.categoryNames) {
      const claimedBy = index.get(categoryName)
      if (claimedBy !== undefined) {
        duplicates.push({
          categoryName,
          courseId: claimedBy,
          ignoredCourseId: course.id,
        })
        continue
      }
      index.set(categoryName, course.id)
    }
  }
  return { index, duplicates }
}

/**
 * Every message id already recorded for `organizationId`, across *every*
 * conversation each of `courses` has — not just the one a given legacy
 * message happens to route to on this run.
 *
 * `messages.id` (`schema.ts`) is a single global primary key, not scoped per
 * conversation, so the re-run dedupe check below has to be scoped the same
 * way: a message previously appended to one conversation and, on a later
 * run, routed to a *different* one (a course's `conversationScope` flipped
 * to `course_surface` creates a new conversation for the same person —
 * D-13) must still be recognised as already-imported, not re-inserted under
 * an id `messages`'s primary key already holds (finding 5 of the MIG-1
 * rework).
 */
function loadExistingMessageIds(
  organizationId: string,
  courses: RoutableCourse[],
  db: Database
): Set<string> {
  const ids = new Set<string>()
  for (const course of courses) {
    for (const conversation of conversationsRepo.listConversationsForCourse(
      organizationId,
      course.id,
      db
    )) {
      for (const message of conversationsRepo.getTranscript(
        organizationId,
        conversation.id,
        db
      )) {
        ids.add(message.id)
      }
    }
  }
  return ids
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
 * Checked against `loadExistingMessageIds`'s global set, read once up front
 * (finding 5) rather than per conversation — a per-conversation check missed
 * a message that a re-run routes to a *different* conversation than it
 * landed on before, and then crashed the whole run on `messages`'s primary
 * key instead of reporting it.
 *
 * A legacy `created_at` that fails to parse is reported in `unplaceable`
 * (finding 8), not thrown out of this function uncaught — `created_at` is
 * `NOT NULL` in the legacy schema, so this is bounded, but a corrupted or
 * hand-edited snapshot should still produce a report, not an aborted run.
 */
export function importMessages(
  organizationId: string,
  legacyMessages: LegacyMessage[],
  personByLegacyUserId: Map<number, string>,
  courses: RoutableCourse[],
  db: Database
): ImportMessagesResult {
  const { index: categoryIndex, duplicates: duplicateCategories } =
    buildCategoryIndex(courses)
  const existingMessageIds = loadExistingMessageIds(organizationId, courses, db)

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

    const messageId = deterministicId(
      'legacy-message',
      organizationId,
      String(legacyMessage.id)
    )
    if (existingMessageIds.has(messageId)) {
      matched += 1
      continue
    }

    let createdAt: number
    try {
      createdAt = parseLegacyTimestamp(legacyMessage.createdAt)
    } catch (error) {
      unplaceable.push({
        legacyMessageId: legacyMessage.id,
        reason: `Unparseable created_at (${JSON.stringify(legacyMessage.createdAt)}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
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
        createdAt,
      },
      db
    )
    existingMessageIds.add(messageId)
    created += 1
  }

  return { created, matched, unplaceable, duplicateCategories }
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
