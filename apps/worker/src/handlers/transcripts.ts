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
 *
 * **PPL-5, applied by withholding identity, not content.** An unfiltered,
 * whole-course export carries every entry's own `direction`/`content`/
 * `createdAt` but never `personId`/`personDisplayName` — see this
 * handler's own comment at the point that happens for the full reasoning
 * (a rework finding, and the coordinator's own call: an earlier draft
 * filtered *entries* by `hasVerifiedAddress`, which silently emptied the
 * export for the ordinary, Discord-only course this platform is actually
 * built for). A *student-filtered* export still carries the one student's
 * own identity it was asked for — that disclosure is the export's whole
 * point — gated on `hasVerifiedAddress` in `transcripts.export`'s own
 * action, unchanged.
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
 * own attachments.
 *
 * The residual window — deletion landing *during* the write itself, after
 * the re-check already passed — is closed the same way, deterministically:
 * when `markExportReady` (below) itself returns `undefined`, this handler
 * knows, in-process, that the bytes it just wrote are now unreferenced,
 * and removes them itself before returning, rather than leaving that to
 * `routes/admin.ts`'s own delayed sweep alone (a rework finding — a
 * `setTimeout` in a *different* process is not a substitute for a
 * synchronous `remove` call in the one place that actually knows the
 * bytes exist: it is `unref()`'d, so a deploy's own `process.exit(0)` on
 * SIGTERM discards it outright if it lands within the sweep's own delay,
 * and a write slow enough to approach `JOB_HANDLER_TIMEOUT_MS`'s own
 * default can already outlive the one-shot sweep that ran before it
 * finished). `routes/admin.ts`'s own sweeps stay, as defence in depth for
 * whatever this handler's own `remove` call fails to clean up — not the
 * only mechanism this platform's own "the tenant's data is deleted"
 * promise depends on.
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

    // PPL-5, applied at the level the disclosure actually happens at — a
    // rework finding, and the coordinator's own call: the per-entry
    // `hasVerifiedAddress` filter this used to run (round two's own first
    // draft) made an *ordinary* course's export come back empty, silently
    // — `omittedForUnverifiedAddress` said so, but only inside the JSON
    // nobody but a script reads, while the panel showed a green tick and a
    // Download link over a file with nothing in it. That defeats ADMIN-3's
    // own text ("an instructor... collects the file when it is ready") for
    // the ordinary case this platform is actually built for: a class that
    // only ever meets students through Discord, where `hasVerifiedAddress`
    // is false for everyone.
    //
    // What round two's own finding actually named was narrower than "an
    // unverified person's content must never leave in a file" — it was
    // that an unfiltered export could still *reconstruct one named
    // person's history* (`jq 'select(.personId=="S")'`), which is PPL-5's
    // own "a person's history", read literally: the *identity* is what
    // makes a transcript a *person's*. So identity, not content, is what
    // an unfiltered export withholds: every entry below carries its own
    // `direction`/`content`/`createdAt` regardless of who sent it, but
    // `personId`/`personDisplayName` are included only when this export
    // names one student (`exportRow.personId` — already refused upstream,
    // in `transcripts.export`'s own action, unless that student's own
    // address is verified) — there is no line in an *unfiltered* file any
    // caller, `jq` included, can attribute to a named student, because the
    // name is not there to select on. A student-filtered export still
    // names exactly the one person it was asked for, deliberately: that
    // disclosure is the export's whole point, and it is already gated.
    const deidentify = exportRow.personId === null
    const transcriptEntries = deidentify
      ? transcript.entries.map(({ direction, content, createdAt }) => ({
          direction,
          content,
          createdAt,
        }))
      : transcript.entries

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
        // De-identified for a whole-course export (this handler's own
        // comment just above) — `deidentified: true` says so plainly in
        // the file itself, the same "an instructor should be told, not
        // left to notice a missing field" reasoning the removed
        // `omittedForUnverifiedAddress` field used to serve for a
        // different, wrong reason.
        deidentified: deidentify,
        transcript: transcriptEntries,
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
      // and this write actually landing — this handler cannot un-write
      // what it already wrote, but it is the one place in this platform
      // that knows, deterministically and in-process, that those bytes
      // are now unreferenced: it just wrote them, to this exact
      // `organizationId`/`exportId`, and the row it would have been
      // written under is gone. A rework finding — this used to return
      // without calling `remove`, leaving `routes/admin.ts`'s own delayed
      // sweep as the *only* thing that ever cleaned this up: a `setTimeout`
      // in a different process, `unref()`'d (so it does not stop that
      // process from exiting on its own), which a deploy's own
      // `process.exit(0)` on SIGTERM discards outright if it lands within
      // the sweep's own delay, and which `JOB_HANDLER_TIMEOUT_MS`'s own
      // default (four minutes) can already outlive on a slow write, long
      // before the one-shot sweep ever gets a second chance to run again.
      // Removed here instead, synchronously, before this handler returns
      // — closing the race deterministically rather than leaving it to a
      // cross-process timer that a deploy can silently discard. The
      // delayed sweep stays, as defence in depth for whatever this
      // `remove` call itself fails to clean up (a transient filesystem
      // error, this same await rejecting) — not the only thing keeping
      // this platform's own promise that a deleted tenant's data is gone.
      await deps.attachmentStorage
        .remove(context.organizationId, exportId)
        .catch(() => {
          // Best-effort, the same as every other cleanup path in this
          // platform (`routes/admin.ts`'s own sweep): a failure here is
          // still caught by that delayed sweep, not a reason to throw out
          // of a handler that has already done everything it correctly
          // could.
        })
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
