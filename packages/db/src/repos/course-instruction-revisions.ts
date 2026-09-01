/**
 * Repository for `course_instruction_revisions` (FILE-4, D-3).
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * there is no exception in this file (TEN-2). A revision is never updated
 * or deleted (this file exports no such function at all — the same
 * "structural, not a rule this file remembers to follow" discipline
 * `discord-scaffold.ts`'s own module comment holds SRV-8 to): restoring an
 * earlier revision (`@bloombot/actions`' `courseInstructions.restore`) adds
 * a *new* row here and updates `courses.instructions`
 * (`repos/courses.ts#setCourseInstructions`) — it never rewrites or removes
 * the row being restored from, so the history a caller already saw stays
 * exactly as long as it was.
 */

import { and, desc, eq } from 'drizzle-orm'

import type { Database } from '../client.js'
import { courseInstructionRevisions } from '../schema.js'

export type CourseInstructionRevision =
  typeof courseInstructionRevisions.$inferSelect

/** Fields the caller supplies when recording a new revision. */
export interface NewCourseInstructionRevision {
  courseId: string
  instructions: string
  /** The account that saved this text — an ordinary save's caller, or a restore's, either way a real author (FILE-4). */
  savedByAccountId: string
}

/**
 * Record a new revision. Called on every save (FILE-4) and on every restore
 * (this file's own module comment) — a restore's own revision carries the
 * restored text and whoever performed the restore as its author.
 *
 * `sequence` (`schema.ts`'s own comment on the column) is computed inside
 * this function's own transaction, as one more than the highest already
 * recorded for this course — the same "read the previous max, write the
 * next value, in one transaction" shape `repos/conversations.ts#appendMessage`
 * already uses for `messages.sequence`, and for the same reason: two saves
 * landing in the same millisecond must still get a real, distinguishable
 * order.
 */
export function createRevision(
  organizationId: string,
  input: NewCourseInstructionRevision,
  db: Database
): CourseInstructionRevision {
  return db.transaction((tx) => {
    const previous = tx
      .select({ sequence: courseInstructionRevisions.sequence })
      .from(courseInstructionRevisions)
      .where(eq(courseInstructionRevisions.courseId, input.courseId))
      .orderBy(desc(courseInstructionRevisions.sequence))
      .limit(1)
      .get()
    const sequence = (previous?.sequence ?? -1) + 1

    return tx
      .insert(courseInstructionRevisions)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        courseId: input.courseId,
        instructions: input.instructions,
        savedByAccountId: input.savedByAccountId,
        sequence,
        createdAt: Date.now(),
      })
      .returning()
      .get()
  })
}

/** Every revision a course has, newest first (by `sequence` — see `schema.ts`'s own comment on why not `createdAt` alone) — what the panel's own "what did we tell it last week" screen reads (FILE-4). */
export function listRevisionsForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): CourseInstructionRevision[] {
  return db
    .select()
    .from(courseInstructionRevisions)
    .where(
      and(
        eq(courseInstructionRevisions.courseId, courseId),
        eq(courseInstructionRevisions.organizationId, organizationId)
      )
    )
    .orderBy(desc(courseInstructionRevisions.sequence))
    .all()
}

/** One revision, scoped to `organizationId` — `undefined` both when it does not exist and when it belongs to another organization (TEN-5), identically. What `courseInstructions.restore` resolves before copying its text forward. */
export function getRevision(
  organizationId: string,
  revisionId: string,
  db: Database
): CourseInstructionRevision | undefined {
  return db
    .select()
    .from(courseInstructionRevisions)
    .where(
      and(
        eq(courseInstructionRevisions.id, revisionId),
        eq(courseInstructionRevisions.organizationId, organizationId)
      )
    )
    .get()
}
