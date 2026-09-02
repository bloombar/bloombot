/**
 * The `transcripts.export` job handler (ADMIN-3) — the background half of
 * `@bloombot/actions`' `transcripts.export` action: that action only
 * enqueues this job and records a `pending` row (`transcriptExports.
 * createPendingExport`); this handler is what actually reads the
 * transcript back and writes a file, the same "the action enqueues, the
 * worker produces" division `courseAttachments.attach`'s own module
 * comment already draws for FILE-1.
 *
 * Reaches the transcript through `@bloombot/db`'s
 * `transcriptAccess.readCourseTranscript` — the *same* function
 * `transcripts.read`'s own `execute` calls — so this job's own read writes
 * exactly the same ADMIN-2 audit row an instructor's on-screen read does
 * (ADMIN-3's own text: "the same audit entry as a read"). This handler
 * never queries `messages` itself.
 *
 * The file itself is JSON — a course's own title, the filters this export
 * was requested with, its usage summary, and its transcript entries — kept
 * to one course's own data (ADMIN-3's "carries only that organization's
 * data", narrowed further here to the one course this export named, not
 * every course the organization happens to have) and written through
 * FILE-5's own `AttachmentStorage`, addressed by the export's own id — the
 * same port, and the same "bytes under an id nothing but the row that
 * names it can be reached without" reasoning, `courseAttachments.attach`'s
 * own handler already uses.
 */

import {
  costLedger,
  transcriptAccess,
  transcriptExports,
  type AttachmentStorage,
  type Database,
} from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'

export const TRANSCRIPT_EXPORT_JOB_KIND = 'transcripts.export'

export interface TranscriptExportHandlerDependencies {
  attachmentStorage: AttachmentStorage
}

/** What this job's own row resolved with — `transcripts.listExports` (`@bloombot/actions`) is what a caller reads this back through (ADMIN-3). */
export type TranscriptExportReport =
  | { exportId: string; status: 'ready'; sizeBytes: number }
  | { exportId: string; status: 'failed'; reason: string }

function parseExportIdPayload(raw: unknown): { exportId: string } {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { exportId?: unknown }).exportId !== 'string'
  ) {
    throw new Error(
      'transcripts.export: payload must be an object shaped { exportId: string }'
    )
  }
  return { exportId: (raw as { exportId: string }).exportId }
}

/** A thrown value `@bloombot/jobs`' own `isPermanentFailure` recognises — the course this export named no longer exists, so retrying can never succeed. */
function permanentFailure(message: string): Error {
  const error = new Error(message) as Error & { permanent: true }
  error.permanent = true
  return error
}

export function createTranscriptExportHandler(
  deps: TranscriptExportHandlerDependencies
): JobHandler {
  return async (
    rawPayload: unknown,
    context: JobContext
  ): Promise<TranscriptExportReport> => {
    const { exportId } = parseExportIdPayload(rawPayload)
    const db: Database = context.db

    const exportRow = transcriptExports.getExport(
      context.organizationId,
      exportId,
      db
    )
    if (!exportRow) {
      throw new Error(
        `transcripts.export: export "${exportId}" was not found in this organization`
      )
    }

    const transcript = transcriptAccess.readCourseTranscript(
      context.organizationId,
      {
        courseId: exportRow.courseId,
        actorAccountId: exportRow.requestedByAccountId,
        kind: 'export',
        ...(exportRow.personId ? { personId: exportRow.personId } : {}),
        ...(exportRow.startAt !== null ? { startAt: exportRow.startAt } : {}),
        ...(exportRow.endAt !== null ? { endAt: exportRow.endAt } : {}),
      },
      db
    )
    if (!transcript) {
      // The course (or, for a student-filtered export, the student) named
      // when this export was requested is gone by the time this job ran —
      // no retry can produce a transcript that no longer resolves.
      const reason =
        'the course (or student) this export named no longer exists'
      transcriptExports.markExportFailed(
        context.organizationId,
        exportId,
        reason,
        db
      )
      throw permanentFailure(reason)
    }

    // ADMIN-3 — this course's own usage only, not every course the
    // organization has: `getOrganizationUsageSummary` reads every course,
    // and this export names one.
    const usageSummary = costLedger.getOrganizationUsageSummary(
      context.organizationId,
      db
    )
    const courseUsage = usageSummary.courses.find(
      (course) => course.courseId === exportRow.courseId
    )

    const fileContent = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        course: { id: transcript.courseId, title: transcript.courseTitle },
        filters: {
          personId: exportRow.personId,
          startAt: exportRow.startAt,
          endAt: exportRow.endAt,
        },
        usage: courseUsage ?? null,
        transcript: transcript.entries,
      },
      null,
      2
    )
    const bytes = Buffer.from(fileContent, 'utf8')

    await deps.attachmentStorage.write(context.organizationId, exportId, bytes)

    transcriptExports.markExportReady(
      context.organizationId,
      exportId,
      {
        filename: `transcript-export-${exportId}.json`,
        contentType: 'application/json',
        sizeBytes: bytes.byteLength,
      },
      db
    )

    return { exportId, status: 'ready', sizeBytes: bytes.byteLength }
  }
}
