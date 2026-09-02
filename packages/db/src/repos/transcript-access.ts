/**
 * ADMIN-1/ADMIN-2/ADMIN-3 — reading a course's transcript back, and the
 * audit trail that read is required to leave.
 *
 * `readCourseTranscript` is the *one* function that actually reads a
 * course's messages back for an instructor or for an export. It is the
 * single, deliberate choke point ADMIN-2's own brief asks for: "the
 * recording should live where the read happens, not in the one screen
 * that happens to call it today." Both `@bloombot/actions`'
 * `transcripts.read` (ADMIN-1) and `transcripts.export`'s own job handler
 * (ADMIN-3, `apps/worker/src/handlers/transcripts.ts`) call this same
 * function to get the messages they show or write to a file — neither
 * queries `messages` itself, and a third caller added later gets the same
 * audit row for free rather than having to remember to write one. Nothing
 * in this file offers a second way to read a course's messages back.
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * there is no exception in this file (TEN-2).
 */

import { and, asc, eq, gte, lte } from 'drizzle-orm'

import type { Database } from '../client.js'
import {
  courses,
  messages,
  people,
  transcriptAccessLog,
  type MessageDirection,
  type TranscriptAccessKind,
} from '../schema.js'

export type TranscriptAccessLogEntry = typeof transcriptAccessLog.$inferSelect

/** One message, with just enough about the student it belongs to for a display or an export — never the student's email or any other identity field beyond a name to show (ADMIN-4's own "sees tenants, not conversations" is about a different screen, but the discipline of naming only what a reader needs is the same one). */
export interface TranscriptEntry {
  personId: string
  personDisplayName: string | null
  direction: MessageDirection
  content: string
  createdAt: number
}

/** What a caller supplies to read (or export) a course's transcript back. */
export interface ReadCourseTranscriptInput {
  courseId: string
  /** The account doing the reading — ADMIN-2's "who". Required: this function refuses (returns `undefined`) rather than log an access nobody is attributed for, the same discipline `dispatch.ts`'s own `accountId` doc comment already holds `courseInstructions.save` to. */
  actorAccountId: string
  /** Narrows to one student's own conversation — ADMIN-1's "filtered by student". Omitted (or `undefined`) reads every student's messages in the course. */
  personId?: string
  /** ADMIN-1's own "filtered by ... date" — inclusive bounds, epoch milliseconds. Either or both may be omitted. */
  startAt?: number
  endAt?: number
  /** `'read'` for the panel screen, `'export'` for the job — ADMIN-3's own "the export ... writes the same audit entry as a read", distinguished only by this field. */
  kind: TranscriptAccessKind
}

export interface ReadCourseTranscriptResult {
  courseId: string
  courseTitle: string
  entries: TranscriptEntry[]
}

/**
 * Read a course's transcript, optionally filtered by student and by date,
 * and write the ADMIN-2 audit row for having done so — both inside the
 * same transaction, so there is no way to get the messages back without
 * the read being recorded (this file's own module comment).
 *
 * `undefined` when `courseId` does not belong to `organizationId`, or
 * `personId` is supplied and does not belong to it either (TEN-2/TEN-5) —
 * refused before anything is read or logged, the same "resolve every id
 * before doing anything with it" order `cost-ledger.ts#recordCostLedgerEntry`
 * already follows.
 */
export function readCourseTranscript(
  organizationId: string,
  input: ReadCourseTranscriptInput,
  db: Database
): ReadCourseTranscriptResult | undefined {
  return db.transaction((tx) => {
    const course = tx
      .select({ id: courses.id, title: courses.title })
      .from(courses)
      .where(
        and(
          eq(courses.id, input.courseId),
          eq(courses.organizationId, organizationId)
        )
      )
      .get()
    if (!course) return undefined

    if (input.personId) {
      const person = tx
        .select({ id: people.id })
        .from(people)
        .where(
          and(
            eq(people.id, input.personId),
            eq(people.organizationId, organizationId)
          )
        )
        .get()
      if (!person) return undefined
    }

    const dateConditions = [
      input.startAt !== undefined
        ? gte(messages.createdAt, input.startAt)
        : undefined,
      input.endAt !== undefined
        ? lte(messages.createdAt, input.endAt)
        : undefined,
    ].filter((condition) => condition !== undefined)

    const rows = tx
      .select({
        personId: messages.personId,
        personDisplayName: people.displayName,
        direction: messages.direction,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(
        people,
        and(
          eq(people.id, messages.personId),
          eq(people.organizationId, organizationId)
        )
      )
      .where(
        and(
          eq(messages.organizationId, organizationId),
          eq(messages.courseId, input.courseId),
          input.personId ? eq(messages.personId, input.personId) : undefined,
          ...dateConditions
        )
      )
      .orderBy(asc(messages.createdAt), asc(messages.sequence))
      .all()

    // ADMIN-2 — written in the same transaction as the read above, not
    // after it: a read that succeeds and an audit write that then fails
    // (or vice versa) must not be possible, or the trail this function
    // exists to keep would be incomplete exactly when something already
    // went wrong.
    tx.insert(transcriptAccessLog)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        courseId: input.courseId,
        actorAccountId: input.actorAccountId,
        personId: input.personId ?? null,
        kind: input.kind,
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        createdAt: Date.now(),
      })
      .run()

    return { courseId: course.id, courseTitle: course.title, entries: rows }
  })
}

/**
 * Every person who has at least one message in `courseId` — ENRL-6's own
 * "ending an enrolment keeps what was said" means a course's transcript can
 * include a student no longer enrolled, so this reads from `messages`
 * directly rather than from `enrolments` (`enrolments.ts#listPeopleForCourse`
 * only ever lists who is *currently* enrolled): ADMIN-1's own student
 * filter has to offer every student the transcript actually covers, not
 * only the ones still admitted today.
 */
export function listPeopleWithTranscript(
  organizationId: string,
  courseId: string,
  db: Database
): { personId: string; personDisplayName: string | null }[] {
  const rows = db
    .selectDistinct({
      personId: messages.personId,
      personDisplayName: people.displayName,
    })
    .from(messages)
    .innerJoin(
      people,
      and(
        eq(people.id, messages.personId),
        eq(people.organizationId, organizationId)
      )
    )
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.courseId, courseId)
      )
    )
    .all()
  return rows
}

/**
 * ADMIN-2's audit trail, read back — every access recorded for one course,
 * newest first. Not itself required by any screen this slice builds (the
 * brief asks that a read be *recorded*, not that the log be displayed
 * anywhere yet), but a write-only table nobody can ever read is not
 * meaningfully an audit trail — this is what a future admin screen, or a
 * test proving ADMIN-2 actually happened, reads through.
 */
export function listAccessLogForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): TranscriptAccessLogEntry[] {
  return db
    .select()
    .from(transcriptAccessLog)
    .where(
      and(
        eq(transcriptAccessLog.organizationId, organizationId),
        eq(transcriptAccessLog.courseId, courseId)
      )
    )
    .orderBy(asc(transcriptAccessLog.createdAt))
    .all()
}
