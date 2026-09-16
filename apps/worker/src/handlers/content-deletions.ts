/**
 * PROJ-8/PROJ-9's own bytes cleanup: `@bloombot/actions`' `courses.delete`/
 * `projects.delete` deletes every row a course (or a project's courses) own
 * in one transaction, but never touches `AttachmentStorage` — the same
 * division `packages/db/src/repos/deletions.ts`'s own module comment draws,
 * and the same one `apps/api/src/routes/admin.ts`'s own `sweepStorage`
 * already follows for a whole tenant (ADMIN-5). This is that division's
 * other half for a course or a project: the action gathers a course
 * attachment's and a transcript export's own ids *before* the delete
 * transaction runs (both tables are gone by the time this job's payload is
 * read), then enqueues this job naming them, so the bytes on disk are
 * removed only after the rows naming them have actually committed as
 * deleted.
 *
 * Best-effort, the same as `sweepStorage`: a byte this handler fails to
 * remove is not a privacy leak reachable through this platform — nothing
 * left in the database references its id — so a single id's own removal
 * failure is logged and skipped rather than failing the whole job (which
 * would otherwise retry a batch where most ids already succeeded). This
 * does not reach the provider (no vector-store or file-object delete, the
 * two calls `courseAttachments.detach`'s own handler makes) — PROJ-8's own
 * text names only the stored bytes and the rows, not a provider-side
 * cleanup, and by the time this job runs, `course_attachments`'s own row
 * (which is what `courseAttachments.detach`'s handler reads `providerFileId`
 * and the course's `vectorStoreId` from) is already gone.
 */

import { type AttachmentStorage } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

export const REMOVE_DELETED_CONTENT_BYTES_JOB_KIND =
  'contentDeletions.removeBytes'

export interface ContentDeletionsHandlerDependencies {
  attachmentStorage: AttachmentStorage
  logger: Logger
}

export interface RemoveDeletedContentBytesReport {
  removed: number
  failed: number
}

function parseIdsPayload(raw: unknown): {
  attachmentIds: string[]
  exportIds: string[]
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      'contentDeletions.removeBytes: payload must be an object shaped { attachmentIds: string[], exportIds: string[] }'
    )
  }
  const { attachmentIds, exportIds } = raw as {
    attachmentIds?: unknown
    exportIds?: unknown
  }
  if (
    !Array.isArray(attachmentIds) ||
    !attachmentIds.every((id) => typeof id === 'string') ||
    !Array.isArray(exportIds) ||
    !exportIds.every((id) => typeof id === 'string')
  ) {
    throw new Error(
      'contentDeletions.removeBytes: payload must be an object shaped { attachmentIds: string[], exportIds: string[] }'
    )
  }
  return { attachmentIds, exportIds }
}

export function createRemoveDeletedContentBytesHandler(
  deps: ContentDeletionsHandlerDependencies
): JobHandler {
  return async (
    rawPayload: unknown,
    context: JobContext
  ): Promise<RemoveDeletedContentBytesReport> => {
    const { attachmentIds, exportIds } = parseIdsPayload(rawPayload)
    const ids = [...attachmentIds, ...exportIds]

    let removed = 0
    let failed = 0
    await Promise.all(
      ids.map(async (id) => {
        try {
          await deps.attachmentStorage.remove(context.organizationId, id)
          removed += 1
        } catch (error) {
          failed += 1
          deps.logger.warn(
            { err: error, organizationId: context.organizationId, id },
            'apps/worker: could not remove a deleted course’s or project’s stored bytes'
          )
        }
      })
    )

    return { removed, failed }
  }
}
