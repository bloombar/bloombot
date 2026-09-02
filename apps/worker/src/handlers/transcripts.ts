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
 * own handler already uses. Every entry is also checked individually
 * against PPL-5's own `hasVerifiedAddress` gate before it is written — see
 * this handler's own comment at the point that happens for the full
 * reasoning (a rework finding: the *request's* own `personId` filter alone
 * left an unfiltered, whole-course export carrying every student's own
 * identity regardless).
 *
 * **ADMIN-5's own race, closed the same way `courseAttachments.attach`
 * already closes it for FILE-1.** Producing the file — `JSON.stringify`
 * over a large course's own transcript, then `Buffer.from` — is not
 * instantaneous, and nothing stops a platform administrator from deleting
 * this tenant while this handler is in the middle of it: `routes/admin.ts`'s
 * own delete removes the `transcript_exports` row (and every other row in
 * the tenant) before this handler ever reaches `attachmentStorage.write`,
 * so a naive write-then-mark-ready would land a departed tenant's own
 * plaintext transcript on disk with no row anywhere left to name it, or to
 * ever remove it — the exact failure `markExportReady` returning nothing
 * (a rework finding) used to leave silent. `exportRow` is re-read,
 * organization-scoped, immediately before the write below; a `deleteOrganizationData`
 * that ran in between reading it the first time and this re-check makes
 * this re-read return `undefined` too (the row is gone), and this handler
 * writes nothing and reports `'abandoned'` instead — the same outcome
 * `createAttachCourseAttachmentHandler`'s own `markAttachmentReady`-returns-
 * `undefined` branch already reports for the identical race on FILE-1's
 * own attachments. `routes/admin.ts`'s own best-effort disk cleanup is the
 * second, later layer, for the sliver of time between this re-check and
 * the write call itself that a re-check alone cannot close (see that
 * file's own module comment).
 */

import {
  costLedger,
  people,
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
  /** ADMIN-5's own race (this file's own module comment) — the export row
   * was removed (a concurrent tenant deletion) after this handler read the
   * transcript but before it wrote the file; nothing was written, and
   * nothing local is left to mark ready or failed. */
  | { exportId: string; status: 'abandoned'; reason: string }

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

    // Must-fix 3 of the ADMIN-1..5 rework — PPL-5, applied per entry, not
    // only at the request's own `personId` filter. `transcripts.export`'s
    // own action refuses outright when the *whole export* names one
    // unverified student, but an *unfiltered*, whole-course export used to
    // carry every entry's own `personId`/`personDisplayName` regardless —
    // `jq '.transcript[] | select(.personId=="S")'` reconstructed exactly
    // the disclosure the filtered path refuses, and for a one-student
    // course the file simply *was* that student's history. Every entry
    // this file actually writes is checked here, individually, against the
    // same `hasVerifiedAddress` gate — cached per person, since a course's
    // transcript is typically many messages from few people, not a fresh
    // lookup per message.
    const verifiedByPersonId = new Map<string, boolean>()
    const verifiedEntries = transcript.entries.filter((entry) => {
      let verified = verifiedByPersonId.get(entry.personId)
      if (verified === undefined) {
        verified =
          people.hasVerifiedAddress(
            context.organizationId,
            entry.personId,
            db
          ) === true
        verifiedByPersonId.set(entry.personId, verified)
      }
      return verified
    })
    const omittedForUnverifiedAddress =
      transcript.entries.length - verifiedEntries.length

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
        // PPL-5 (this handler's own comment just above) — an entry from a
        // person with no verified address is never written, whatever the
        // filters this export was requested with; `omittedForUnverifiedAddress`
        // says honestly that the file is not the whole transcript when that
        // happened, rather than looking silently complete.
        transcript: verifiedEntries,
        omittedForUnverifiedAddress,
      },
      null,
      2
    )
    const bytes = Buffer.from(fileContent, 'utf8')

    // ADMIN-5's own race — re-checked immediately before the write, not
    // trusted from the `exportRow` read at the top of this handler (this
    // file's own module comment has the full reasoning).
    const stillExists = transcriptExports.getExport(
      context.organizationId,
      exportId,
      db
    )
    if (!stillExists) {
      return {
        exportId,
        status: 'abandoned',
        reason:
          'the export (or its tenant) was deleted before the file was written — nothing was written',
      }
    }

    // A rework finding — a non-permanent failure here (a full disk, a
    // permissions error) used to propagate unguarded: `@bloombot/jobs`'
    // own retry/backoff (JOB-2) is correct for it, but once attempts were
    // exhausted the *job* row reached its own terminal `failed` state while
    // this row stayed `pending` forever — the second way, besides the
    // stopped-worker case, an export could sit `pending` indefinitely with
    // nothing left retrying it. Guarded the same way
    // `createAttachCourseAttachmentHandler`'s own step 2-4 sequence already
    // is: on this job's own last attempt, mark the row `failed` before
    // re-throwing, so both rows land in the same terminal state together.
    try {
      await deps.attachmentStorage.write(
        context.organizationId,
        exportId,
        bytes
      )
    } catch (error) {
      if (
        context.maxAttempts !== undefined &&
        context.attempts >= context.maxAttempts
      ) {
        const reason = error instanceof Error ? error.message : String(error)
        transcriptExports.markExportFailed(
          context.organizationId,
          exportId,
          `gave up after ${context.attempts} attempt(s): ${reason}`,
          db
        )
      }
      throw error
    }

    const ready = transcriptExports.markExportReady(
      context.organizationId,
      exportId,
      {
        filename: `transcript-export-${exportId}.json`,
        contentType: 'application/json',
        sizeBytes: bytes.byteLength,
      },
      db
    )
    if (!ready) {
      // The row vanished in the narrow window between the re-check above
      // and this write actually landing — `routes/admin.ts`'s own delayed
      // sweep (this file's own module comment) is what removes these
      // bytes; this handler cannot un-write what it already wrote, but it
      // must not claim a row that is not there to mark.
      return {
        exportId,
        status: 'abandoned',
        reason:
          'the export (or its tenant) was deleted while the file was being written',
      }
    }

    return { exportId, status: 'ready', sizeBytes: bytes.byteLength }
  }
}
