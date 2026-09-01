/**
 * The `courseAttachments.attach` and `courseAttachments.detach` job
 * handlers (FILE-1..3) — the provider half of a course's knowledge files,
 * moved behind the queue the same way `discord-scaffold.ts`'s SRV-6..8 and
 * `roster-import.ts`'s ROST-9..12 already are (that file's own module
 * comment: several shapes are reused rather than reinvented — a handler
 * closing over its own dependencies, organization-scoped lookups reaching
 * "not found" for a foreign id the same way every scoped repo already
 * does, and a job's own `result` carrying its report).
 *
 * **`courseAttachments.attach` (FILE-1, FILE-2):**
 *  1. Read the attachment's row and its bytes (`@bloombot/db`'s
 *     `createFilesystemAttachmentStorage`) — both already written by
 *     `@bloombot/actions`' `courseAttachments.attach` action before this job
 *     was ever enqueued (the action's own module comment has why: a
 *     filesystem write is not the network call this queue exists to defer,
 *     FILE-1's own text).
 *  2. Upload the bytes to the provider (`@bloombot/openai`'s `uploadFile`).
 *  3. Resolve the vector store to attach it to: the course's own
 *     `vectorStoreId` when it already has one — hand-typed (D-3's escape
 *     hatch) or set by an earlier attachment, either way left alone — or a
 *     freshly created one when it does not (FILE-1's own "replacing a
 *     vector store id typed in from a vendor dashboard").
 *  4. Attach the file to that store.
 *  5. On success: `markAttachmentReady`, and `setCourseVectorStoreIdIfUnset`
 *     — the course's `vectorStoreId` is only ever *written* once this file
 *     is actually grounding answers, never eagerly at step 3, which is
 *     exactly what keeps FILE-2's promise: a course must never look
 *     configured while an attachment sits unresolved or failed. On a
 *     provider rejection (a `client_error`, or `attachFileToVectorStore`'s
 *     own `status: 'failed'`): `markAttachmentFailed`, carrying the
 *     provider's own reason, and `courses.vectorStoreId` is left exactly as
 *     it was — untouched, never set to a store that may hold nothing useful.
 *     A *transient* failure (timeout, rate limit, 5xx) is not caught at all
 *     here — it propagates, and `@bloombot/jobs`' own retry/backoff (JOB-2)
 *     is what tries again, the same division every other handler in this
 *     app already holds itself to.
 *
 * **`courseAttachments.detach` (FILE-3):** removes the file from the
 * course's vector store and deletes the file object itself — the two
 * provider calls FILE-3's own text means by "the removal must reach the
 * provider, not only the platform's own record" — then deletes the bytes
 * (`AttachmentStorage#remove`) and the row (`deleteAttachment`). An
 * attachment that never reached `ready` (still `pending`, or already
 * `failed`) has no `providerFileId` to reach the provider with at all —
 * detaching one skips straight to removing the bytes and the row, since
 * there is nothing on the provider's side to undo.
 */

import {
  courseAttachments,
  courses,
  type AttachmentStorage,
  type Database,
} from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import {
  attachFileToVectorStore,
  createVectorStore,
  deleteFile,
  deleteVectorStoreFile,
  ModelRequestError,
  uploadFile,
  type FilesHttpOptions,
} from '@bloombot/openai'

export const ATTACH_COURSE_ATTACHMENT_JOB_KIND = 'courseAttachments.attach'
export const DETACH_COURSE_ATTACHMENT_JOB_KIND = 'courseAttachments.detach'

export interface CourseAttachmentsHandlerDependencies {
  openaiHttpOptions: FilesHttpOptions
  attachmentStorage: AttachmentStorage
}

/** What `courseAttachments.attach`'s own job resolved with — `jobs.get` (`@bloombot/actions`) is what a caller reads this back through (FILE-2). */
export type AttachAttachmentReport =
  | { attachmentId: string; status: 'ready'; providerFileId: string }
  | { attachmentId: string; status: 'failed'; reason: string }

export type DetachAttachmentReport =
  | { attachmentId: string; detached: true }
  /** The attachment was already gone by the time this job ran (a second detach, a foreign id) — reported rather than thrown, since there is nothing left to undo either way. */
  | { attachmentId: string; detached: false; reason: string }

function parseAttachmentIdPayload(raw: unknown): { attachmentId: string } {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { attachmentId?: unknown }).attachmentId !== 'string'
  ) {
    throw new Error(
      'courseAttachments: payload must be an object shaped { attachmentId: string }'
    )
  }
  return { attachmentId: (raw as { attachmentId: string }).attachmentId }
}

/** The vector store name a freshly created one gets — an instructor never sees this id (it lives in `courses.vectorStoreId` once set), so this only has to be recognisable in the provider's own dashboard. */
function vectorStoreName(courseTitle: string): string {
  return `Bloombot — ${courseTitle}`
}

export function createAttachCourseAttachmentHandler(
  deps: CourseAttachmentsHandlerDependencies
): JobHandler {
  return async (
    rawPayload: unknown,
    context: JobContext
  ): Promise<AttachAttachmentReport> => {
    const { attachmentId } = parseAttachmentIdPayload(rawPayload)
    const db: Database = context.db

    const attachment = courseAttachments.getAttachment(
      context.organizationId,
      attachmentId,
      db
    )
    if (!attachment) {
      throw new Error(
        `courseAttachments.attach: attachment "${attachmentId}" was not found in this organization`
      )
    }

    const course = courses.getCourse(
      context.organizationId,
      attachment.courseId,
      db
    )
    if (!course) {
      throw new Error(
        `courseAttachments.attach: course "${attachment.courseId}" was not found in this organization`
      )
    }

    const bytes = await deps.attachmentStorage.read(
      context.organizationId,
      attachmentId
    )
    if (!bytes) {
      throw new Error(
        `courseAttachments.attach: no bytes on disk for attachment "${attachmentId}" — the action that enqueued this job should have written them first`
      )
    }

    // Step 2 — upload. A provider rejection here (bad content, an
    // unsupported type) is a `client_error`: caught and recorded on the
    // row, not thrown (see this file's own module comment on FILE-2).
    // Anything else propagates for JOB-2's ordinary retry.
    let fileId: string
    try {
      fileId = await uploadFile(deps.openaiHttpOptions, {
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes,
      })
    } catch (error) {
      if (error instanceof ModelRequestError && !error.retryable) {
        courseAttachments.markAttachmentFailed(
          context.organizationId,
          attachmentId,
          error.message,
          db
        )
        return { attachmentId, status: 'failed', reason: error.message }
      }
      throw error
    }

    // Step 3 — reuse the course's own vector store id when it has one
    // (hand-typed or already derived); create one only when it does not.
    const vectorStoreId =
      course.vectorStoreId ??
      (await createVectorStore(
        deps.openaiHttpOptions,
        vectorStoreName(course.title)
      ))

    // Step 4/5 — attach, and record the outcome. `attachFileToVectorStore`
    // itself already turns a provider-reported rejection into
    // `{ status: 'failed', reason }` rather than throwing (`files.ts`'s own
    // doc comment) — a transient failure still throws through it, for the
    // same JOB-2 retry every other propagated error here gets.
    const attached = await attachFileToVectorStore(
      deps.openaiHttpOptions,
      vectorStoreId,
      fileId
    )
    if (attached.status === 'failed') {
      courseAttachments.markAttachmentFailed(
        context.organizationId,
        attachmentId,
        attached.reason,
        db
      )
      return { attachmentId, status: 'failed', reason: attached.reason }
    }

    courseAttachments.markAttachmentReady(
      context.organizationId,
      attachmentId,
      fileId,
      db
    )
    // FILE-1/D-3 — only written once the file is actually grounding
    // answers; a no-op if the course already had a `vectorStoreId` (this
    // run's own `vectorStoreId` above, or a hand-typed one it read instead).
    courses.setCourseVectorStoreIdIfUnset(
      context.organizationId,
      course.id,
      vectorStoreId,
      db
    )

    return { attachmentId, status: 'ready', providerFileId: fileId }
  }
}

export function createDetachCourseAttachmentHandler(
  deps: CourseAttachmentsHandlerDependencies
): JobHandler {
  return async (
    rawPayload: unknown,
    context: JobContext
  ): Promise<DetachAttachmentReport> => {
    const { attachmentId } = parseAttachmentIdPayload(rawPayload)
    const db: Database = context.db

    const attachment = courseAttachments.getAttachment(
      context.organizationId,
      attachmentId,
      db
    )
    if (!attachment) {
      // Already gone (a second detach reaching the queue, a race with
      // another removal) — nothing left to undo on the provider either.
      return {
        attachmentId,
        detached: false,
        reason: 'attachment already removed',
      }
    }

    // FILE-3 — reaches the provider before touching the local record, so a
    // provider failure (propagated, JOB-2's ordinary retry) never leaves an
    // attachment removed locally while it still grounds answers upstream.
    // An attachment that never reached `ready` has no `providerFileId` —
    // nothing to undo on the provider's side.
    if (attachment.providerFileId) {
      const course = courses.getCourse(
        context.organizationId,
        attachment.courseId,
        db
      )
      if (course?.vectorStoreId) {
        await deleteVectorStoreFile(
          deps.openaiHttpOptions,
          course.vectorStoreId,
          attachment.providerFileId
        )
      }
      await deleteFile(deps.openaiHttpOptions, attachment.providerFileId)
    }

    await deps.attachmentStorage.remove(context.organizationId, attachmentId)
    courseAttachments.deleteAttachment(context.organizationId, attachmentId, db)

    return { attachmentId, detached: true }
  }
}
