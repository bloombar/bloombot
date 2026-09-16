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
 * never a failure, which is exactly what makes retrying this job after a
 * partial batch failure idempotent. Transcript exports never reach the
 * provider at all — they are never uploaded anywhere, only written to
 * `AttachmentStorage` locally (`repos/transcript-exports.ts`'s own module
 * comment).
 *
 * Best-effort throughout, the same as `sweepStorage`: a single id's own
 * removal failure — local or at the provider — is logged and skipped
 * rather than failing the whole job (which would otherwise retry a batch
 * where most ids already succeeded).
 */

import { type AttachmentStorage } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'
import {
  deleteFile,
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

function parseCoursesPayload(raw: unknown): CoursePayload[] {
  const invalid = (): never => {
    throw new Error(
      'contentDeletions.removeBytes: payload must be an object shaped ' +
        '{ courses: { courseId: string, vectorStoreId: string | null, ' +
        'attachments: { attachmentId: string, providerFileId: string | null }[], ' +
        'exportIds: string[] }[] }'
    )
  }
  if (typeof raw !== 'object' || raw === null) return invalid()
  const { courses } = raw as { courses?: unknown }
  if (!Array.isArray(courses)) return invalid()

  return courses.map((entry) => {
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
    const courses = parseCoursesPayload(rawPayload)

    let bytesRemoved = 0
    let bytesFailed = 0
    let providerFilesRemoved = 0
    let providerFilesFailed = 0

    const removeBytes = async (id: string): Promise<void> => {
      try {
        await deps.attachmentStorage.remove(context.organizationId, id)
        bytesRemoved += 1
      } catch (error) {
        bytesFailed += 1
        deps.logger.warn(
          { err: error, organizationId: context.organizationId, id },
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
              }
            }
            await removeBytes(attachment.attachmentId)
          })
        )
        await Promise.all(
          course.exportIds.map((exportId) => removeBytes(exportId))
        )
      })
    )

    return {
      bytesRemoved,
      bytesFailed,
      providerFilesRemoved,
      providerFilesFailed,
    }
  }
}
