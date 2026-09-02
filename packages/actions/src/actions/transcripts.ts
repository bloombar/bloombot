/**
 * Actions over `packages/db`'s `transcript-access`/`transcript-exports`
 * repos (ADMIN-1..3): reading a course's transcript in the panel, and
 * exporting it as a job.
 *
 * `transcripts.read` and `transcripts.export`'s own job handler
 * (`apps/worker/src/handlers/transcripts.ts`) both call the exact same
 * `@bloombot/db` function — `transcriptAccess.readCourseTranscript` — to
 * actually fetch the messages, which is what makes ADMIN-2's audit trail
 * unbypassable: the recording lives inside that one function, not in
 * either of these two actions, so neither can reach a transcript's
 * contents without it. See that function's own module comment.
 *
 * Both actions need the caller's own account id — an access nobody is
 * attributed for is exactly what ADMIN-2 exists to prevent — so both read
 * `context.accountId` and refuse outright when it is missing, the same
 * `requireAccountId` discipline `course-instructions.ts`'s own module
 * comment already holds `courseInstructions.save`/`.restore` to.
 *
 * **PPL-5, deliberately applied to `.export` and not to `.read`.**
 * `people.hasVerifiedAddress` gates a *self-service* disclosure — PPL-5's
 * own text is "one proves which account is speaking, the other decides
 * what may be shown", and D-35's rework finding 4 built the check around a
 * caller asserting their *own* identity, not a third party's. An
 * instructor reading a course's transcript in the panel is not that: the
 * instructor's own identity is already proven by their signed-in account
 * (AUTH-1/AUTH-2, always a verified email by construction), their
 * authority to read it comes from their membership role (ENRL-5), and the
 * read is itself the ADMIN-2 audit event that makes it accountable —
 * gating it further on whether the *student* has ever linked a web account
 * would make CONV-2's own retention guarantee hollow for the ordinary case
 * (a class that only ever uses Discord, where no student links one) and is
 * not the disclosure PPL-5 is describing. Export is different in kind, not
 * merely in degree: it produces a portable file, addressed to one named
 * student when `personId` is given, that leaves the panel's own
 * access-controlled screen and audit boundary entirely — the shape PPL-5's
 * own "exporting a person's history" names most literally. So a
 * *student-filtered* export refuses unless that student's own identity has
 * been verified (`hasVerifiedAddress`); an unfiltered, whole-course export
 * (transcripts and usage together, ADMIN-3's own text) carries no single
 * person's history to gate on and is not refused this way. Recorded in
 * `docs/DECISIONS.md` D-46.
 */

import {
  courses,
  jobs,
  people,
  transcriptAccess,
  transcriptExports,
} from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Course = NonNullable<ReturnType<typeof courses.getCourse>>

/** Every action here refuses the same way when `dispatch` was not given an authenticated caller — see this file's own module comment. */
function requireAccountId(accountId: string | undefined): string {
  if (!accountId) throw new ActionRefusedError()
  return accountId
}

const dateRangeSchema = {
  personId: z.string().min(1).optional(),
  startAt: z.number().int().nonnegative().optional(),
  endAt: z.number().int().nonnegative().optional(),
}

const readInputSchema = z.object({
  courseId: z.string().min(1),
  ...dateRangeSchema,
})
type ReadInput = z.infer<typeof readInputSchema>

/** ADMIN-1: read a course's transcript, optionally filtered by student and by date. Recorded to the ADMIN-2 audit trail by `readCourseTranscript` itself. */
export const readTranscriptAction: Action<
  'transcripts.read',
  ReadInput,
  Course,
  transcriptAccess.ReadCourseTranscriptResult
> = {
  name: 'transcripts.read',
  description:
    "Read a course's transcript in the panel (ADMIN-1), optionally filtered by student and by date — every read is written to an audit trail (ADMIN-2).",
  inputSchema: readInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, input, entity, accountId, db }) => {
    const actorAccountId = requireAccountId(accountId)
    const result = transcriptAccess.readCourseTranscript(
      organizationId,
      {
        courseId: entity.id,
        actorAccountId,
        kind: 'read',
        ...(input.personId !== undefined ? { personId: input.personId } : {}),
        ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
        ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
      },
      db
    )
    // Unreachable in practice — the policy just proved this course exists
    // and belongs to this organization moments earlier — but guarded
    // rather than assumed, the same race every other action in this
    // package's own comments already document for the identical shape.
    if (!result) throw new ActionRefusedError()
    return result
  },
}

const listStudentsInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListStudentsInput = z.infer<typeof listStudentsInputSchema>

/** ADMIN-1's own student filter: every person the course's transcript actually covers — including a student no longer enrolled (ENRL-6) — not merely who is enrolled today. */
export const listTranscriptStudentsAction: Action<
  'transcripts.listStudents',
  ListStudentsInput,
  Course,
  { personId: string; personDisplayName: string | null }[]
> = {
  name: 'transcripts.listStudents',
  description:
    "List every student a course's transcript covers (ADMIN-1's own student filter) — including one no longer enrolled.",
  inputSchema: listStudentsInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    transcriptAccess.listPeopleWithTranscript(organizationId, entity.id, db),
}

const exportInputSchema = z.object({
  courseId: z.string().min(1),
  ...dateRangeSchema,
})
type ExportInput = z.infer<typeof exportInputSchema>

// The job `kind` `apps/worker`'s `handlers/transcripts.ts` registers its
// handler under — a literal string here too, the same
// cross-referenced-by-comment convention `discordServers.scaffold`'s own
// `DISCORD_SCAFFOLD_JOB_KIND` already uses: an app does not import from
// another app, and this package does not depend on `apps/worker`.
const TRANSCRIPT_EXPORT_JOB_KIND = 'transcripts.export'

// JOB-2's bound on attempts — the same reasoning every other job-enqueuing
// action's own constant gives.
const TRANSCRIPT_EXPORT_MAX_ATTEMPTS = 5

/**
 * ADMIN-3: request that a course's transcript (and usage) be exported as a
 * file, produced by a background job (JOB-1). Resolves the course itself
 * (ACT-2); when `input.personId` is given, also requires that student's own
 * verified address (PPL-5 — see this file's own module comment for why
 * `.export` checks this and `.read` does not) before a row is even
 * created. Enqueues a `transcripts.export` job naming the pending export
 * row; producing the file and marking it ready or failed is
 * `apps/worker`'s own handler's concern once it claims the job, the same
 * division `courseAttachments.attach` already holds itself to.
 */
export const exportTranscriptAction: Action<
  'transcripts.export',
  ExportInput,
  Course,
  { exportId: string; jobId: string }
> = {
  name: 'transcripts.export',
  description:
    "Export a course's transcript and usage as a file (ADMIN-3), produced by a background job — this action does not itself produce the file.",
  inputSchema: exportInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, input, entity, accountId, db }) => {
    const requestedByAccountId = requireAccountId(accountId)

    // PPL-5 — a student-filtered export is refused unless the platform has
    // itself verified that student's address (this file's own module
    // comment has the full reasoning). `undefined` (the person does not
    // exist, or belongs to another organization, TEN-5) refuses the same
    // way `false` does — ACT-3's single, identical refusal either way.
    if (input.personId !== undefined) {
      const verified = people.hasVerifiedAddress(
        organizationId,
        input.personId,
        db
      )
      if (verified !== true) throw new ActionRefusedError()
    }

    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      {
        courseId: entity.id,
        requestedByAccountId,
        ...(input.personId !== undefined ? { personId: input.personId } : {}),
        ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
        ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
      },
      db
    )

    const job = jobs.enqueueJob(
      organizationId,
      {
        kind: TRANSCRIPT_EXPORT_JOB_KIND,
        payload: { exportId: exportRow.id },
        maxAttempts: TRANSCRIPT_EXPORT_MAX_ATTEMPTS,
      },
      db
    )

    return { exportId: exportRow.id, jobId: job.id }
  },
}

const listExportsInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListExportsInput = z.infer<typeof listExportsInputSchema>

/** ADMIN-3's own "collect the file when it is ready": every export a course has requested, most recent first, with its current status. */
export const listTranscriptExportsAction: Action<
  'transcripts.listExports',
  ListExportsInput,
  Course,
  transcriptExports.TranscriptExport[]
> = {
  name: 'transcripts.listExports',
  description:
    "List a course's transcript exports (ADMIN-3), most recent first, each with its own status.",
  inputSchema: listExportsInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    transcriptExports.listExportsForCourse(organizationId, entity.id, db),
}
