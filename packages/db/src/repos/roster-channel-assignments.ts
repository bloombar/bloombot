/**
 * Repository for `roster_channel_assignments` (ROST-17) — the durable record
 * of which Discord channel belongs to which person in which course, so
 * `apps/worker`'s `roster.import` handler stops finding a student's channel
 * by recomputing the name it would create (a name that can legitimately
 * drift — ROST-14's own disambiguation, an instructor's rename, a corrected
 * address) and starts remembering it outright.
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * the same TEN-2 discipline every other repo in this package holds itself
 * to (`course-web-sources.ts`'s own module comment) — `undefined` alike for
 * a row that does not exist and one that belongs to another organization
 * (TEN-5).
 */

import { and, eq } from 'drizzle-orm'

import type { Executor, TransactingExecutor } from '../client.js'
import { writeTransaction } from '../client.js'
import { rosterChannelAssignments } from '../schema.js'

export type RosterChannelAssignment =
  typeof rosterChannelAssignments.$inferSelect

/** Fields the caller supplies when recording a student's channel. */
export interface NewRosterChannelAssignment {
  courseId: string
  personId: string
  discordChannelId: string
}

/**
 * A person's remembered channel for a course, if any — the lookup the
 * import handler runs first, ahead of any name-based matching, for every
 * roster row (ROST-17's own requirement 2: a student who already has a
 * channel is never given another, whatever it is called now).
 */
export function getChannelAssignmentForPerson(
  organizationId: string,
  courseId: string,
  personId: string,
  db: Executor
): RosterChannelAssignment | undefined {
  return db
    .select()
    .from(rosterChannelAssignments)
    .where(
      and(
        eq(rosterChannelAssignments.organizationId, organizationId),
        eq(rosterChannelAssignments.courseId, courseId),
        eq(rosterChannelAssignments.personId, personId)
      )
    )
    .get()
}

/**
 * Whichever person a Discord channel is already remembered as belonging to,
 * if any — what the import handler checks before *adopting* a channel it
 * only matched by name (requirement 3): a channel already remembered as
 * another person's must never be handed to a second one, whatever its name
 * now matches.
 */
export function getChannelAssignmentByDiscordChannelId(
  organizationId: string,
  discordChannelId: string,
  db: Executor
): RosterChannelAssignment | undefined {
  return db
    .select()
    .from(rosterChannelAssignments)
    .where(
      and(
        eq(rosterChannelAssignments.organizationId, organizationId),
        eq(rosterChannelAssignments.discordChannelId, discordChannelId)
      )
    )
    .get()
}

/**
 * Record (or update) which channel belongs to a person in a course — called
 * once a channel is created fresh, once an existing one is adopted by name
 * for the first time (requirement 3), and once a remembered channel that
 * had been deleted from the server is recreated (requirement 4).
 *
 * Two different unique constraints (`schema.ts`'s own module comment) can
 * each be the one this call actually lands on, so this is a read-then-write
 * inside its own transaction rather than a single `onConflictDoUpdate`
 * targeting just one of them:
 *
 * - The *same* row is found by `(courseId, personId)` and updated in place
 *   when this person already has a remembered channel for this course —
 *   the ordinary "reconfirm" case, and requirement 4's "replace the
 *   deleted channel's id" case.
 * - The row is instead found by `discordChannelId` *within the same
 *   course* and its `personId` reassigned when this exact channel is
 *   already remembered, just under a *different* person — `apps/worker`'s
 *   own handler takes this path deliberately narrowly, only for the one
 *   case its own module comment documents as a pre-existing identity-model
 *   gap it does not close: a roster row whose handle resolves to nobody,
 *   then resolves to a real member on a later import, is two different
 *   `people` rows for the same real student. Without this branch, recording
 *   the channel for the newly-resolved person would collide on
 *   `discordChannelId` and throw, rather than simply reassigning the
 *   remembered ownership onto whichever person this row currently resolves
 *   to. Scoped to `courseId` as well as `discordChannelId` — never
 *   reassigning a record across courses, even though `discordChannelId`
 *   alone is already globally unique — so this branch's own effect stays
 *   exactly what its name says: moving *who* a channel belongs to within
 *   one course, never *which* course a record belongs to.
 * - Neither is found (including a `discordChannelId` remembered under a
 *   *different* course, which this function does not reassign): a fresh
 *   row is inserted.
 */
export function recordChannelAssignment(
  organizationId: string,
  input: NewRosterChannelAssignment,
  db: TransactingExecutor
): RosterChannelAssignment {
  return writeTransaction(db, (tx) => {
    const byPerson = tx
      .select()
      .from(rosterChannelAssignments)
      .where(
        and(
          eq(rosterChannelAssignments.organizationId, organizationId),
          eq(rosterChannelAssignments.courseId, input.courseId),
          eq(rosterChannelAssignments.personId, input.personId)
        )
      )
      .get()
    if (byPerson) {
      return tx
        .update(rosterChannelAssignments)
        .set({ discordChannelId: input.discordChannelId })
        .where(eq(rosterChannelAssignments.id, byPerson.id))
        .returning()
        .get()
    }

    const byChannelInThisCourse = tx
      .select()
      .from(rosterChannelAssignments)
      .where(
        and(
          eq(rosterChannelAssignments.organizationId, organizationId),
          eq(rosterChannelAssignments.courseId, input.courseId),
          eq(rosterChannelAssignments.discordChannelId, input.discordChannelId)
        )
      )
      .get()
    if (byChannelInThisCourse) {
      return tx
        .update(rosterChannelAssignments)
        .set({ personId: input.personId })
        .where(eq(rosterChannelAssignments.id, byChannelInThisCourse.id))
        .returning()
        .get()
    }

    return tx
      .insert(rosterChannelAssignments)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        courseId: input.courseId,
        personId: input.personId,
        discordChannelId: input.discordChannelId,
        createdAt: Date.now(),
      })
      .returning()
      .get()
  })
}
