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
 * **PPL-5, applied by withholding identity fields, not content — and not
 * called "de-identified".** An unfiltered, whole-course export carries
 * every entry's own `direction`/`content`/`createdAt` but never
 * `personId`/`personDisplayName`; each entry's own student is instead
 * named only by a `participant` pseudonym ("P1", "P2", ...) assigned
 * fresh, randomly ordered, on every export of the same course, so a
 * caller cannot correlate one export's own `P1` with another's, a roster,
 * or Discord. See this handler's own comment at the point that happens
 * for the full reasoning (a rework finding, and the coordinator's own
 * call, twice over: an earlier draft filtered *entries* by
 * `hasVerifiedAddress`, which silently emptied the export for the
 * ordinary, Discord-only course this platform is actually built for; the
 * draft after that called the result "de-identified", which a second
 * reviewer correctly rejected — this platform's own opening line for a
 * conversation (`packages/openai/src/conversations.ts`) deliberately
 * seeds it with the student's own name, "My name is ${displayName}...",
 * and a reply routinely echoes it back, so stripping two fields off an
 * entry whose own *text* still says "Hi Sarah —" does not de-identify
 * anything). `identityFieldsOmitted: true` in the file below claims only
 * what is actually true — those two fields are gone — and a `notice`
 * string next to it says plainly that the text itself may still name
 * someone; `docs/DECISIONS.md` D-48 records the full trade this costs). A
 * *student-filtered* export still carries the one student's own identity
 * it was asked for — that disclosure is the export's whole point — gated
 * on `hasVerifiedAddress` in `transcripts.export`'s own action, unchanged.
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

import { createHash, randomBytes } from 'node:crypto'
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

/**
 * Assigns every distinct student appearing in `entries` a "P1"/"P2"/...
 * label — stable across every entry in *this* call, so a reader can still
 * tell two entries came from the same person, but ordered by a hash
 * salted with `randomBytes`, freshly minted on every call and never
 * stored anywhere: the same student's own label does not repeat, or even
 * keep the same ordinal, the next time this function runs for the same
 * course (this file's own module comment, and `docs/DECISIONS.md` D-48,
 * have the reasoning this trade rests on, and the objection to it).
 */
function assignPseudonyms(
  entries: readonly { personId: string }[]
): Map<string, string> {
  const salt = randomBytes(16).toString('hex')
  const orderKey = (personId: string) =>
    createHash('sha256').update(salt).update(personId).digest('hex')

  const distinctPersonIds = [...new Set(entries.map((entry) => entry.personId))]
  distinctPersonIds.sort((a, b) => {
    const keyA = orderKey(a)
    const keyB = orderKey(b)
    if (keyA < keyB) return -1
    if (keyA > keyB) return 1
    return 0
  })

  return new Map(
    distinctPersonIds.map((personId, index) => [personId, `P${index + 1}`])
  )
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
    // rework finding, and the coordinator's own call, twice over: the
    // per-entry `hasVerifiedAddress` filter this used to run (round two's
    // own first draft) made an *ordinary* course's export come back
    // empty, silently — `omittedForUnverifiedAddress` said so, but only
    // inside the JSON nobody but a script reads, while the panel showed a
    // green tick and a Download link over a file with nothing in it. That
    // defeats ADMIN-3's own text ("an instructor... collects the file
    // when it is ready") for the ordinary case this platform is actually
    // built for: a class that only ever meets students through Discord,
    // where `hasVerifiedAddress` is false for everyone.
    //
    // What round two's own finding actually named was narrower than "an
    // unverified person's content must never leave in a file" — it was
    // that an unfiltered export could still *reconstruct one named
    // person's history* (`jq 'select(.personId=="S")'`), which is PPL-5's
    // own "a person's history", read literally: the *identity* is what
    // makes a transcript a *person's*. Round three's own first draft
    // withheld `personId`/`personDisplayName` on that reasoning and
    // called the result "de-identified" — which a second reviewer
    // correctly rejected: this platform's own opening line for a
    // conversation (`packages/openai/src/conversations.ts`) deliberately
    // seeds it with the student's own name ("My name is
    // ${displayName}..."), and a model's own reply routinely echoes it
    // back ("Hi Sarah — the midterm is on..."), verbatim, in the stored
    // message text this export reads back. Two fields being gone from an
    // entry whose own `content` still names the student is not
    // de-identification; it is a false assurance, worse than none.
    //
    // So this export withholds identity *fields* (unchanged from round
    // three's first draft — `personId`/`personDisplayName` never appear
    // in an unfiltered export's own entries) but claims only that, under
    // the accurate name `identityFieldsOmitted`, and says so again, in
    // plain language, in the `notice` string below — the same "said
    // where a reader will see it, not left inside a field nobody but a
    // script reads" correction this file's own module comment already
    // draws from `omittedForUnverifiedAddress`'s own mistake. Content is
    // not filtered, deliberately — the coordinator's own repeated
    // instruction across every round of this rework — so what an
    // unfiltered export actually gives up is narrower than "follows one
    // student's own thread": every one of the reasons an instructor
    // exports at all (participation, a student stuck for weeks, an
    // integrity question, a wellbeing escalation) is per-student work,
    // and none of it survives an unfiltered export naming nobody —
    // `docs/DECISIONS.md` D-48 records this trade, and the objection to
    // it, in full.
    //
    // What an unfiltered export *does* still support is corpus-level use
    // — reading every message a course produced without knowing whose it
    // was — and for that, a bare "no name at all" is worse than it needs
    // to be: two entries from the same student, unmarked, read as two
    // strangers, though it is often exactly "does this keep coming from
    // the same person" a corpus read wants to know. `assignPseudonyms`
    // (below) answers that without naming anyone: every entry carries a
    // `participant` label ("P1", "P2", ...) stable across every entry in
    // *this* export, but assigned in an order randomised fresh on every
    // export — the coordinator's own explicit call, with the coordinator's
    // own objection recorded alongside it in D-48: a stable, unnamed
    // label still lets `jq 'select(.participant=="P1")'` return one
    // person's whole history inside this one file, the shape round one's
    // own finding first raised, PPL-5 gates a *named* person's history,
    // and "P1" resolves to nobody outside this file — not a roster, not a
    // second export of the same course, not Discord. A student-filtered
    // export is unchanged: it still names exactly the one person it was
    // asked for, deliberately — that disclosure is the export's whole
    // point, and it is already gated on `hasVerifiedAddress`.
    const identityFieldsOmitted = exportRow.personId === null
    const pseudonymByPersonId = identityFieldsOmitted
      ? assignPseudonyms(transcript.entries)
      : undefined
    const transcriptEntries = pseudonymByPersonId
      ? transcript.entries.map(
          ({ personId, direction, content, createdAt }) => {
            const participant = pseudonymByPersonId.get(personId)
            // Invariant, not a real branch: `pseudonymByPersonId` is built
            // from these exact entries' own `personId`s, immediately above.
            if (!participant) {
              throw new Error(
                `transcripts.export: no pseudonym assigned for person "${personId}"`
              )
            }
            return { participant, direction, content, createdAt }
          }
        )
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
        // What is actually true, named accurately (this handler's own
        // comment just above) — not "de-identified", which the message
        // text below can defeat on its own.
        identityFieldsOmitted,
        ...(identityFieldsOmitted
          ? {
              notice:
                'Student ids and display names are omitted and replaced ' +
                'below with a pseudonym ("participant") unique to this ' +
                'export — it will not match any other export of this ' +
                'course. The message text itself is not filtered, and ' +
                'may still name a student.',
            }
          : {}),
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
