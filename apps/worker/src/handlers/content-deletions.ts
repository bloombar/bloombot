/**
 * PROJ-8/PROJ-9's own bytes cleanup: `@bloombot/actions`' `courses.delete`/
 * `projects.delete` deletes every row a course (or a project's courses) own
 * in one transaction, but never touches `AttachmentStorage`, and never
 * reaches the model provider — the same division
 * `packages/db/src/repos/deletions.ts`'s own module comment draws, and the
 * same one `apps/api/src/routes/admin.ts`'s own `sweepStorage` already
 * follows for a whole tenant (ADMIN-5), for the local-bytes half of it.
 * This is that division's other half for a course or a project.
 *
 * The action gathers each course's own `CourseByteRemoval`
 * (`@bloombot/db`'s `deletions.ts`) *inside* the delete's own transaction —
 * every attachment's own `providerFileId`, the course's own `vectorStoreId`,
 * and every export's own id — then enqueues this job naming them, so both
 * the local bytes and the provider-side resources are removed only after
 * the rows naming them have actually committed as deleted.
 *
 * DATA-8's own retention sweep (`handlers/retention-sweep.ts`) also enqueues
 * this job, for a *whole organization*'s own bytes, once that organization
 * itself has already been permanently removed — `ParsedPayload`'s own doc
 * comment (below) has why the payload can carry an explicit `organizationId`
 * for that one case, distinct from `context.organizationId` (the job row's
 * own organization, which cannot be the one just deleted).
 *
 * **Reaching the provider**, for every attachment that ever recorded a
 * `providerFileId` (FILE-1): remove it from the course's own vector store
 * (when the course had one), then delete the file object itself — the
 * identical two calls, in the identical order,
 * `courseAttachments.detach`'s own handler
 * (`handlers/course-attachments.ts`) makes; `deleteIgnoringAlreadyGone`
 * below is a deliberate, small duplicate of that file's own private helper
 * of the same name, not a shared export — a `404` from either call means
 * "already gone" (an earlier attempt that reached the provider but was
 * never recorded, or a retry of this same job after a partial success),
 * never a failure. The store itself is also deleted, once per course
 * (cheap-fix 2, rework round 2) — `deleteVectorStore`, 404-tolerant the
 * same way. Transcript exports never reach the provider at all — they are
 * never uploaded anywhere, only written to `AttachmentStorage` locally
 * (`repos/transcript-exports.ts`'s own module comment).
 *
 * **Local bytes are best-effort** (the same as `sweepStorage`): a single
 * id's own removal failure is logged and skipped rather than failing the
 * whole job. **A provider failure is not** (must-fix 1, rework round 2,
 * correcting this file's own earlier claim that it was): a non-404
 * response removing a vector-store entry, a file object, or a store itself
 * is logged, that attachment's own local bytes are deliberately left in
 * place (never reached by `removeBytes`), and this job throws once every
 * course has been processed — `@bloombot/jobs`' own retry policy (JOB-2)
 * is what actually gets the provider delete to succeed on a later attempt.
 * Removing local bytes for an attachment the provider still holds would
 * mean nothing left anywhere that still names the id to retry against —
 * exactly the orphan this whole job exists to prevent.
 */

import { type AttachmentStorage } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'
import {
  deleteFile,
  deleteVectorStore,
  deleteVectorStoreFile,
  ModelRequestError,
  type FilesHttpOptions,
} from '@bloombot/openai'

export const REMOVE_DELETED_CONTENT_BYTES_JOB_KIND =
  'contentDeletions.removeBytes'

export interface ContentDeletionsHandlerDependencies {
  attachmentStorage: AttachmentStorage
  openaiHttpOptions: FilesHttpOptions
  logger: Logger
}

export interface RemoveDeletedContentBytesReport {
  bytesRemoved: number
  bytesFailed: number
  providerFilesRemoved: number
  providerFilesFailed: number
  vectorStoresRemoved: number
  vectorStoresFailed: number
}

interface AttachmentPayload {
  attachmentId: string
  providerFileId: string | null
}

interface CoursePayload {
  courseId: string
  vectorStoreId: string | null
  attachments: AttachmentPayload[]
  exportIds: string[]
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * DATA-8 rework, must-fix 1 — what `parsePayload` (below) hands back:
 * `courses`, the same as before, plus an *optional* `organizationId`. When
 * present, it names the organization whose bytes these actually are, for
 * `removeBytes` below to pass to `AttachmentStorage` — which is keyed by
 * organization id (`packages/db`'s `attachment-storage.ts`) — *instead of*
 * `context.organizationId`, the job row's own organization. The two are the
 * same for an ordinary course or project delete (`deletions.deleteCourse`/
 * `deleteProject`, `@bloombot/actions`' `enqueueRemoveDeletedContentBytes`),
 * which never sets this field, so `context.organizationId` is used exactly
 * as before. They diverge for `handlers/retention-sweep.ts`'s own
 * organization-level removal: the organization whose bytes these are has
 * already been deleted by the time this job can run (`organizations.ts#deleteOrganizationData`'s
 * own doc comment on why `jobs.organizationId` cannot name it), so that job
 * is attached to a *different*, still-existing organization purely to
 * satisfy `jobs.organizationId`'s own foreign key, and this field is what
 * tells `removeBytes` where the actual bytes live instead.
 */
interface ParsedPayload {
  organizationId?: string
  courses: CoursePayload[]
}

function parsePayload(raw: unknown): ParsedPayload {
  const invalid = (): never => {
    throw new Error(
      'contentDeletions.removeBytes: payload must be an object shaped ' +
        '{ organizationId?: string, courses: { courseId: string, vectorStoreId: string | null, ' +
        'attachments: { attachmentId: string, providerFileId: string | null }[], ' +
        'exportIds: string[] }[] }'
    )
  }
  if (typeof raw !== 'object' || raw === null) return invalid()
  const { organizationId, courses } = raw as {
    organizationId?: unknown
    courses?: unknown
  }
  if (organizationId !== undefined && typeof organizationId !== 'string') {
    return invalid()
  }
  if (!Array.isArray(courses)) return invalid()

  const parsedCourses = courses.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return invalid()
    const { courseId, vectorStoreId, attachments, exportIds } = entry as Record<
      string,
      unknown
    >
    if (
      typeof courseId !== 'string' ||
      !isStringOrNull(vectorStoreId) ||
      !Array.isArray(attachments) ||
      !Array.isArray(exportIds) ||
      !exportIds.every((id) => typeof id === 'string')
    ) {
      return invalid()
    }
    const parsedAttachments = attachments.map((attachment) => {
      if (typeof attachment !== 'object' || attachment === null) {
        return invalid()
      }
      const { attachmentId, providerFileId } = attachment as Record<
        string,
        unknown
      >
      if (typeof attachmentId !== 'string' || !isStringOrNull(providerFileId)) {
        return invalid()
      }
      return { attachmentId, providerFileId }
    })
    return {
      courseId,
      vectorStoreId,
      attachments: parsedAttachments,
      exportIds,
    }
  })

  return {
    ...(organizationId === undefined ? {} : { organizationId }),
    courses: parsedCourses,
  }
}

/**
 * FILE-3's own rework finding, duplicated from
 * `handlers/course-attachments.ts`'s own private helper of the same name
 * (this file's own module comment has why it is not shared/exported
 * instead): a `404` from either provider delete means "already gone," not
 * a failure to undo — without this, a retried removal (the vector-store
 * entry already gone from an earlier partial success, say) burns every
 * attempt as an uncaught `client_error`.
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

export function createRemoveDeletedContentBytesHandler(
  deps: ContentDeletionsHandlerDependencies
): JobHandler {
  return async (
    rawPayload: unknown,
    context: JobContext
  ): Promise<RemoveDeletedContentBytesReport> => {
    const { organizationId: payloadOrganizationId, courses } =
      parsePayload(rawPayload)
    // DATA-8 rework, must-fix 1 — the organization these bytes actually
    // belong to, on disk: the payload's own `organizationId` when this job
    // was enqueued naming one explicitly (`ParsedPayload`'s own doc comment
    // has why), `context.organizationId` — the job row's own organization —
    // otherwise, exactly as before this rework.
    const bytesOrganizationId = payloadOrganizationId ?? context.organizationId

    let bytesRemoved = 0
    let bytesFailed = 0
    let providerFilesRemoved = 0
    let providerFilesFailed = 0
    let vectorStoresRemoved = 0
    let vectorStoresFailed = 0

    const removeBytes = async (id: string): Promise<void> => {
      try {
        await deps.attachmentStorage.remove(bytesOrganizationId, id)
        bytesRemoved += 1
      } catch (error) {
        bytesFailed += 1
        deps.logger.warn(
          { err: error, organizationId: bytesOrganizationId, id },
          'apps/worker: could not remove a deleted course’s or project’s stored bytes'
        )
      }
    }

    await Promise.all(
      courses.map(async (course) => {
        await Promise.all(
          course.attachments.map(async (attachment) => {
            // FILE-3 — reach the provider first, the same order
            // `courseAttachments.detach`'s own handler holds itself to: a
            // provider failure must never leave local bytes removed while
            // the provider still holds (or might still hold) a copy this
            // platform no longer has a row to name. An attachment whose
            // upload never reached the provider has nothing there to undo.
            if (attachment.providerFileId) {
              try {
                if (course.vectorStoreId) {
                  await deleteIgnoringAlreadyGone(() =>
                    deleteVectorStoreFile(
                      deps.openaiHttpOptions,
                      course.vectorStoreId as string,
                      attachment.providerFileId as string
                    )
                  )
                }
                await deleteIgnoringAlreadyGone(() =>
                  deleteFile(
                    deps.openaiHttpOptions,
                    attachment.providerFileId as string
                  )
                )
                providerFilesRemoved += 1
              } catch (error) {
                // Rework round 2, must-fix 1: a provider failure here used
                // to be logged and then, one line below, the local bytes
                // were removed anyway — the job then reported success, so
                // nothing ever retried, and the provider went on holding a
                // file object with no row anywhere left to name it,
                // forever. Skipping the local removal (the `return` below,
                // never reaching `removeBytes`) keeps this attachment's
                // bytes on disk until a retry actually gets the provider
                // delete to succeed — `deleteIgnoringAlreadyGone`'s own
                // 404-as-already-gone handling is what keeps that retry
                // idempotent rather than re-throwing on a delete that
                // already landed.
                providerFilesFailed += 1
                deps.logger.warn(
                  {
                    err: error,
                    organizationId: context.organizationId,
                    attachmentId: attachment.attachmentId,
                    providerFileId: attachment.providerFileId,
                  },
                  'apps/worker: could not remove a deleted course’s attachment from the provider'
                )
                return
              }
            }
            await removeBytes(attachment.attachmentId)
          })
        )
        await Promise.all(
          course.exportIds.map((exportId) => removeBytes(exportId))
        )
        // Cheap-fix 2 (rework round 2): the vector store itself, once its
        // own course is gone — attempted regardless of whether every file
        // inside it was removed above, the same "each resource cleaned up
        // on its own merits" reasoning `removeBytes` already applies to
        // every attachment and export id independently. A store with no
        // id (no attachment of this course ever reached `ready`, or a
        // hand-typed one that was later cleared) has nothing to delete.
        if (course.vectorStoreId) {
          try {
            await deleteIgnoringAlreadyGone(() =>
              deleteVectorStore(
                deps.openaiHttpOptions,
                course.vectorStoreId as string
              )
            )
            vectorStoresRemoved += 1
          } catch (error) {
            vectorStoresFailed += 1
            deps.logger.warn(
              {
                err: error,
                organizationId: context.organizationId,
                courseId: course.courseId,
                vectorStoreId: course.vectorStoreId,
              },
              'apps/worker: could not remove a deleted course’s own vector store from the provider'
            )
          }
        }
      })
    )

    // Must-fix 1 — a provider delete that failed (not merely a 404, which
    // `deleteIgnoringAlreadyGone` never lets reach here at all) must make
    // this job attempt fail, so `@bloombot/jobs`' own retry policy (JOB-2)
    // actually retries it. Thrown once, after every course has been
    // processed — not on the first failure — so one course's own failure
    // never stops another course's independent cleanup from running.
    if (providerFilesFailed > 0 || vectorStoresFailed > 0) {
      throw new Error(
        `contentDeletions.removeBytes: ${providerFilesFailed} attachment(s) and ${vectorStoresFailed} vector store(s) could not be removed from the provider — retrying`
      )
    }

    return {
      bytesRemoved,
      bytesFailed,
      providerFilesRemoved,
      providerFilesFailed,
      vectorStoresRemoved,
      vectorStoresFailed,
    }
  }
}
