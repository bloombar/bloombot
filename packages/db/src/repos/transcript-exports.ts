/**
 * Repository for `transcript_exports` (ADMIN-3, JOB-1).
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * there is no exception in this file (TEN-2). Mirrors `course-attachments.ts`'s
 * own pending/ready/failed shape: `createPendingExport` when
 * `@bloombot/actions`' `transcripts.export` action enqueues the job,
 * `markExportReady`/`markExportFailed` once `apps/worker`'s handler has
 * actually produced (or failed to produce) the file. Nothing here touches
 * `AttachmentStorage` or reads a message — this file only ever reads or
 * writes the row; the bytes live in FILE-5's own storage, addressed by
 * this row's own `id`, and the messages themselves are
 * `repos/transcript-access.ts#readCourseTranscript`'s concern.
 */

import { and, desc, eq } from 'drizzle-orm'

import type { Database } from '../client.js'
import { transcriptExports, type TranscriptExportStatus } from '../schema.js'

export type TranscriptExport = typeof transcriptExports.$inferSelect

/** Fields the caller supplies when recording a new, not-yet-produced export. */
export interface NewTranscriptExport {
  /** Defaults to `crypto.randomUUID()` when omitted — the id `AttachmentStorage`'s own directory will be keyed by (mirroring FILE-5), so a caller that wants to write the bytes under an id it already knows may pass one. */
  id?: string
  courseId: string
  /** `undefined` — every student the course's transcript covers. Set — one student's own history (PPL-5's own gate, checked by the action before this row is even created). */
  personId?: string
  requestedByAccountId: string
  startAt?: number
  endAt?: number
}

/**
 * Insert a fresh export row, `status: 'pending'` — `apps/worker`'s handler
 * is what moves it to `ready` or `failed` once it has actually produced
 * the file.
 *
 * `sequence` (`schema.ts`'s own comment on the column) is computed inside
 * this function's own transaction, as one more than the highest already
 * recorded for this course — the same "read the previous max, write the
 * next value, in one transaction" shape
 * `course-instruction-revisions.ts#createRevision` already uses for its
 * own `sequence`, for the same reason: two exports requested in the same
 * millisecond must still get a real, distinguishable order.
 */
export function createPendingExport(
  organizationId: string,
  input: NewTranscriptExport,
  db: Database
): TranscriptExport {
  return db.transaction((tx) => {
    const previous = tx
      .select({ sequence: transcriptExports.sequence })
      .from(transcriptExports)
      .where(
        and(
          eq(transcriptExports.courseId, input.courseId),
          eq(transcriptExports.organizationId, organizationId)
        )
      )
      .orderBy(desc(transcriptExports.sequence))
      .limit(1)
      .get()
    const sequence = (previous?.sequence ?? -1) + 1
    const now = Date.now()

    return tx
      .insert(transcriptExports)
      .values({
        id: input.id ?? crypto.randomUUID(),
        organizationId,
        courseId: input.courseId,
        personId: input.personId ?? null,
        requestedByAccountId: input.requestedByAccountId,
        status: 'pending',
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        filename: null,
        contentType: null,
        sizeBytes: null,
        failureReason: null,
        sequence,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
  })
}

/** One export, scoped to `organizationId` — `undefined` both when it does not exist and when it belongs to another organization (TEN-5), identically. */
export function getExport(
  organizationId: string,
  exportId: string,
  db: Database
): TranscriptExport | undefined {
  return db
    .select()
    .from(transcriptExports)
    .where(
      and(
        eq(transcriptExports.id, exportId),
        eq(transcriptExports.organizationId, organizationId)
      )
    )
    .get()
}

/** Every export a course has requested, most recent first (by `sequence` — see `schema.ts`'s own comment on why not `createdAt` alone) — what an instructor's own "collect the file" screen reads (ADMIN-3). */
export function listExportsForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): TranscriptExport[] {
  return db
    .select()
    .from(transcriptExports)
    .where(
      and(
        eq(transcriptExports.courseId, courseId),
        eq(transcriptExports.organizationId, organizationId)
      )
    )
    .orderBy(desc(transcriptExports.sequence))
    .all()
}

/** The file has been produced: `status: 'ready'`, carrying what a download route needs to serve it. `undefined` if `exportId` does not resolve in this organization (TEN-5). */
export function markExportReady(
  organizationId: string,
  exportId: string,
  file: { filename: string; contentType: string; sizeBytes: number },
  db: Database
): TranscriptExport | undefined {
  return db
    .update(transcriptExports)
    .set({
      status: 'ready',
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      failureReason: null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(transcriptExports.id, exportId),
        eq(transcriptExports.organizationId, organizationId)
      )
    )
    .returning()
    .get()
}

/** The job could not produce the file: `status: 'failed'`, carrying why — the same "a caller must be able to tell 'still working' from 'dead'" discipline `course_attachments`' own `failed` status already gives FILE-2. */
export function markExportFailed(
  organizationId: string,
  exportId: string,
  reason: string,
  db: Database
): TranscriptExport | undefined {
  return db
    .update(transcriptExports)
    .set({
      status: 'failed',
      failureReason: reason,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(transcriptExports.id, exportId),
        eq(transcriptExports.organizationId, organizationId)
      )
    )
    .returning()
    .get()
}

export type { TranscriptExportStatus }
