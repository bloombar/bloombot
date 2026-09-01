/**
 * Repository for `course_attachments` (FILE-1..3, FILE-5).
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * there is no exception in this file (TEN-2). Nothing here touches
 * `AttachmentStorage` (`../attachment-storage.ts`) or a provider — this is
 * purely the row's own lifecycle: `createPendingAttachment` on upload,
 * `markAttachmentReady`/`markAttachmentFailed` once `apps/worker`'s handler
 * has heard back from the provider, and `deleteAttachment` once a detach's
 * own provider call has succeeded. The bytes and the provider-side state
 * are each their own caller's concern (`attachment-storage.ts`,
 * `@bloombot/openai`) — this file only ever reads or writes the row.
 */

import { and, eq } from 'drizzle-orm'

import type { Database } from '../client.js'
import { courseAttachments, type AttachmentStatus } from '../schema.js'

export type CourseAttachment = typeof courseAttachments.$inferSelect

/** Fields the caller supplies when recording a new, not-yet-uploaded attachment. */
export interface NewCourseAttachment {
  /** Defaults to `crypto.randomUUID()` when omitted — the id `AttachmentStorage`'s own directory is keyed by (FILE-5), so a caller that already wrote the bytes under a fresh id passes it here rather than letting this function mint a second one. */
  id?: string
  courseId: string
  filename: string
  contentType: string
  sizeBytes: number
}

/** Insert a fresh attachment row, `status: 'pending'` (FILE-2) — the bytes are expected to already be on disk under this same id by the time this is called; `apps/worker`'s handler is what moves it to `ready` or `failed`. */
export function createPendingAttachment(
  organizationId: string,
  input: NewCourseAttachment,
  db: Database
): CourseAttachment {
  const now = Date.now()
  return db
    .insert(courseAttachments)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      courseId: input.courseId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: 'pending',
      providerFileId: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
}

/** One attachment, scoped to `organizationId` — `undefined` both when it does not exist and when it belongs to another organization (TEN-5), identically. */
export function getAttachment(
  organizationId: string,
  attachmentId: string,
  db: Database
): CourseAttachment | undefined {
  return db
    .select()
    .from(courseAttachments)
    .where(
      and(
        eq(courseAttachments.id, attachmentId),
        eq(courseAttachments.organizationId, organizationId)
      )
    )
    .get()
}

/** Every attachment a course has, in the order they were created — what the panel's own "knowledge files" list reads (FILE-1, FILE-2). */
export function listAttachmentsForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): CourseAttachment[] {
  return db
    .select()
    .from(courseAttachments)
    .where(
      and(
        eq(courseAttachments.courseId, courseId),
        eq(courseAttachments.organizationId, organizationId)
      )
    )
    .all()
}

/**
 * FILE-1/FILE-5 — a rework finding: records the provider's own file id the
 * moment the upload itself succeeds, before either of `apps/worker`'s
 * handler's own two later provider calls (creating a vector store, attaching
 * the file to it) run — `status` is left exactly as it was (still
 * `'pending'`, not yet `'ready'`), only `providerFileId` changes. Without
 * this, a rejection or an exhausted retry on either later call left
 * `providerFileId` `null` forever, and `courseAttachments.detach`'s own
 * `if (attachment.providerFileId)` guard (`apps/worker`'s handler) skipped
 * both provider deletes for exactly the row that most needed them — the
 * uploaded file stayed on the provider permanently, costing storage nobody
 * could see or remove. `undefined` if `attachmentId` does not resolve in
 * this organization (TEN-5), the same contract every write function in this
 * package holds itself to.
 */
export function recordProviderFileId(
  organizationId: string,
  attachmentId: string,
  providerFileId: string,
  db: Database
): CourseAttachment | undefined {
  return db
    .update(courseAttachments)
    .set({
      providerFileId,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(courseAttachments.id, attachmentId),
        eq(courseAttachments.organizationId, organizationId)
      )
    )
    .returning()
    .get()
}

/** FILE-1 — the provider has uploaded and attached the file: `status: 'ready'`, carrying its own id. `undefined` if `attachmentId` does not resolve in this organization (TEN-5) — the same "the caller already knows why" contract every write function in this package holds itself to. */
export function markAttachmentReady(
  organizationId: string,
  attachmentId: string,
  providerFileId: string,
  db: Database
): CourseAttachment | undefined {
  return db
    .update(courseAttachments)
    .set({
      status: 'ready',
      providerFileId,
      failureReason: null,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(courseAttachments.id, attachmentId),
        eq(courseAttachments.organizationId, organizationId)
      )
    )
    .returning()
    .get()
}

/** FILE-2 — the provider rejected the file: `status: 'failed'`, carrying its own reason, so a course never looks configured while this attachment leaves its answers ungrounded. */
export function markAttachmentFailed(
  organizationId: string,
  attachmentId: string,
  reason: string,
  db: Database
): CourseAttachment | undefined {
  return db
    .update(courseAttachments)
    .set({
      status: 'failed',
      failureReason: reason,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(courseAttachments.id, attachmentId),
        eq(courseAttachments.organizationId, organizationId)
      )
    )
    .returning()
    .get()
}

/** FILE-3 — removes the row entirely, once the caller has already reached the provider (`courseAttachments.detach`'s own job handler) and removed the bytes (`attachment-storage.ts`). Never called on its own to "hide" an attachment — see this file's own module comment. Returns whether a row was actually deleted, so a caller can tell a stale or foreign id (TEN-5) from a real removal. */
export function deleteAttachment(
  organizationId: string,
  attachmentId: string,
  db: Database
): boolean {
  const result = db
    .delete(courseAttachments)
    .where(
      and(
        eq(courseAttachments.id, attachmentId),
        eq(courseAttachments.organizationId, organizationId)
      )
    )
    .run()
  return result.changes > 0
}

export type { AttachmentStatus }
