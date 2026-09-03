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

import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'

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
    //
    // `sequence` (`schema.ts`'s own comment on the column) is computed
    // here, as one more than the highest already recorded for this course
    // — the same "read the previous max, write the next value, in one
    // transaction" shape this file's own `appendMessage`-adjacent
    // `messages.sequence` convention already uses, for the same reason:
    // two accesses landing in the same millisecond must still get a real,
    // distinguishable order.
    const previousAccess = tx
      .select({ sequence: transcriptAccessLog.sequence })
      .from(transcriptAccessLog)
      .where(
        and(
          eq(transcriptAccessLog.courseId, input.courseId),
          eq(transcriptAccessLog.organizationId, organizationId)
        )
      )
      .orderBy(desc(transcriptAccessLog.sequence))
      .limit(1)
      .get()
    const accessSequence = (previousAccess?.sequence ?? -1) + 1

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
        sequence: accessSequence,
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
 *
 * Ordered by display name, then by `personId` as a tiebreaker (two people
 * can share a display name, or have none at all) — a rework finding: this
 * had no `ORDER BY` at all, so the panel's own student dropdown
 * (`pages/Transcripts.tsx`) rendered in whatever order SQLite happened to
 * return rows in, which is not guaranteed stable across reloads.
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
    .orderBy(asc(people.displayName), asc(messages.personId))
    .all()
  return rows
}

/**
 * ADMIN-2's audit trail, read back — every access recorded for one course,
 * newest first. An audit (`docs/ROADMAP.md`'s "Audit — surfaces that were
 * never built") found this function had zero callers outside a test — the
 * only other reference in the repo was a comment in `schema.ts` — so
 * ADMIN-2's "written to an audit trail" held while its "an institution has
 * to be able to account for" did not: nothing in the panel, `/admin` or MCP
 * ever read a row back. `@bloombot/actions`'s `transcripts.listAccessLog`
 * is the caller that closes that gap — see that action's own module
 * comment for who may call it, and why.
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
    .orderBy(desc(transcriptAccessLog.sequence))
    .all()
}
