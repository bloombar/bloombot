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
 *  2. Upload the bytes to the provider (`@bloombot/openai`'s `uploadFile`),
 *     then immediately `recordProviderFileId` — a rework finding: a rejection
 *     or an exhausted retry on either of the two calls below used to leave
 *     `providerFileId` `null` forever, which is exactly what let
 *     `courseAttachments.detach`'s own `if (attachment.providerFileId)`
 *     guard skip both provider deletes for the row that most needed them.
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
 *     configured while an attachment sits unresolved or failed. A
 *     concurrent `courseAttachments.detach` that removed this row while
 *     steps 2-4 were still in flight (`markAttachmentReady` itself returns
 *     `undefined` when that happens, TEN-5's usual contract) is a rework
 *     finding of its own: `courses.vectorStoreId` is left untouched for a
 *     file nothing local records any more, and this reports `'abandoned'`
 *     rather than falsely claiming `'ready'`.
 *
 * Steps 2-4 are one guarded sequence, not two (another rework finding — the
 * original only guarded step 2): a *non-retryable* provider rejection from
 * any of them (a `client_error`, or `attachFileToVectorStore`'s own
 * `status: 'failed'`) is caught and recorded — `markAttachmentFailed`,
 * carrying the provider's own reason — and `courses.vectorStoreId` is left
 * exactly as it was, never set to a store that may hold nothing useful. A
 * *retryable* failure (timeout, rate limit, 5xx) still propagates for
 * `@bloombot/jobs`' own retry/backoff (JOB-2), the same division every
 * other handler in this app holds itself to — except on this job's own
 * *last* attempt (`context.maxAttempts`, a rework finding): propagating
 * there would leave the row `pending` forever once JOB-2 gives up, with no
 * way for a caller to tell "still working" from "dead" — exactly what
 * FILE-2 exists to prevent — so the last attempt also calls
 * `markAttachmentFailed` before re-throwing, leaving both the job row and
 * the attachment row in the same terminal state.
 *
 * **`courseAttachments.detach` (FILE-3):** removes the file from the
 * course's vector store and deletes the file object itself — the two
 * provider calls FILE-3's own text means by "the removal must reach the
 * provider, not only the platform's own record" — then deletes the bytes
 * (`AttachmentStorage#remove`) and the row (`deleteAttachment`). An
 * attachment that never reached `ready` (still `pending`, or already
 * `failed`) may still carry a `providerFileId` (step 2 above records it
 * before either later call runs) — detaching one still reaches the
 * provider; only an attachment whose upload itself never succeeded has
 * nothing there to undo. A `404` from either provider delete (a rework
 * finding) is treated as "already gone", not a failure: an earlier detach
 * attempt that succeeded on the provider but was never recorded locally
 * (a timeout after the call actually landed, the classic at-least-once
 * retry shape) must not leave this row permanently undeletable.
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
  type AttachFileToVectorStoreResult,
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
  /** A rework finding — a concurrent `courseAttachments.detach` removed this attachment's own row while this attach's provider calls were still in flight; there is nothing left locally to mark ready or failed. */
  | { attachmentId: string; status: 'abandoned'; reason: string }

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

    // Steps 2-4 — one guarded sequence (a rework finding — the original
    // guarded only step 2, leaving a non-retryable rejection from step 3 or
    // 4 to propagate and strand the attachment `pending` with no reason).
    // A `client_error` anywhere in here is caught and recorded on the row,
    // not thrown (see this file's own module comment on FILE-2). Anything
    // else propagates for JOB-2's ordinary retry — except on this job's own
    // last attempt, where propagating would leave the row `pending` forever
    // once JOB-2 gives up (this file's own module comment, another rework
    // finding).
    let fileId: string
    let vectorStoreId: string
    let attached: AttachFileToVectorStoreResult
    try {
      // Step 2 — upload.
      fileId = await uploadFile(deps.openaiHttpOptions, {
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes,
      })

      // Recorded the instant the upload succeeds, before either call below
      // runs (this file's own module comment, FILE-5's own "record the id
      // as soon as the upload succeeds") — so a rejection or an exhausted
      // retry on either of them still leaves `courseAttachments.detach`
      // something to reach on the provider.
      courseAttachments.recordProviderFileId(
        context.organizationId,
        attachmentId,
        fileId,
        db
      )

      // Step 3 — reuse the course's own vector store id when it has one
      // (hand-typed or already derived); create one only when it does not.
      vectorStoreId =
        course.vectorStoreId ??
        (await createVectorStore(
          deps.openaiHttpOptions,
          vectorStoreName(course.title)
        ))

      // Step 4 — attach. `attachFileToVectorStore` itself already turns a
      // provider-reported rejection into `{ status: 'failed', reason }`
      // rather than throwing (`files.ts`'s own doc comment) — a transient
      // failure still throws through it, caught by this same block.
      attached = await attachFileToVectorStore(
        deps.openaiHttpOptions,
        vectorStoreId,
        fileId
      )
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
      // A transient failure. `context.maxAttempts` is `undefined` for a
      // test that calls this handler directly, bypassing the queue
      // (`JobContext.maxAttempts`'s own doc comment) — treated the same as
      // "not the last attempt", the ordinary propagate-for-retry path,
      // since there is nothing to compare `context.attempts` against.
      if (
        context.maxAttempts !== undefined &&
        context.attempts >= context.maxAttempts
      ) {
        const reason = error instanceof Error ? error.message : String(error)
        courseAttachments.markAttachmentFailed(
          context.organizationId,
          attachmentId,
          `gave up after ${context.attempts} attempt(s): ${reason}`,
          db
        )
      }
      throw error
    }

    if (attached.status === 'failed') {
      courseAttachments.markAttachmentFailed(
        context.organizationId,
        attachmentId,
        attached.reason,
        db
      )
      return { attachmentId, status: 'failed', reason: attached.reason }
    }

    const readyAttachment = courseAttachments.markAttachmentReady(
      context.organizationId,
      attachmentId,
      fileId,
      db
    )
    if (!readyAttachment) {
      // A rework finding — a concurrent `courseAttachments.detach` removed
      // this row while steps 2-4 above were still in flight (TEN-5's usual
      // "resolves to nothing" contract, not a thrown error). Nothing left
      // locally to mark ready, and `courses.vectorStoreId` must not be set
      // for a file nothing local records any more — see this file's own
      // module comment.
      return {
        attachmentId,
        status: 'abandoned',
        reason:
          'the attachment was removed (a concurrent detach) before this attach completed',
      }
    }
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
    // An attachment whose upload itself never succeeded has no
    // `providerFileId` — nothing to undo on the provider's side.
    const providerFileId = attachment.providerFileId
    if (providerFileId) {
      const course = courses.getCourse(
        context.organizationId,
        attachment.courseId,
        db
      )
      const vectorStoreId = course?.vectorStoreId
      if (vectorStoreId) {
        await deleteIgnoringAlreadyGone(() =>
          deleteVectorStoreFile(
            deps.openaiHttpOptions,
            vectorStoreId,
            providerFileId
          )
        )
      }
      await deleteIgnoringAlreadyGone(() =>
        deleteFile(deps.openaiHttpOptions, providerFileId)
      )
    }

    await deps.attachmentStorage.remove(context.organizationId, attachmentId)
    courseAttachments.deleteAttachment(context.organizationId, attachmentId, db)

    return { attachmentId, detached: true }
  }
}

/**
 * FILE-3 — a rework finding: a `404` from either provider delete means
 * "already gone", not a failure to undo. Without this, a retried detach
 * (the first delete succeeds, the second times out; JOB-2 retries; the
 * retry 404s on the delete that already landed) burns every attempt as an
 * uncaught `client_error` — five failed attempts later the row is stuck
 * `ready`, its bytes still on disk, in a state this platform itself created
 * and has no way to leave. Anything other than a `404` (a real client
 * error, a transient failure) still propagates for JOB-2's ordinary retry —
 * this is not a blanket "ignore every provider error" guard.
 */
async function deleteIgnoringAlreadyGone(
  remove: () => Promise<void>
): Promise<void> {
  try {
    await remove()
  } catch (error) {
    if (error instanceof ModelRequestError && error.status === 404) {
      return
    }
    throw error
  }
}
