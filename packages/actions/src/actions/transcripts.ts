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
 * *student-filtered* export refuses here, in this action, unless that
 * student's own identity has been verified (`hasVerifiedAddress`) —
 * refused before a `transcript_exports` row is even created, since the
 * export names exactly the one person's history PPL-5 gates.
 *
 * An **unfiltered, whole-course export** is not refused this way — it
 * names no single person's history to gate on the way a filtered one does
 * — but it is not ungated either: a rework finding, after an earlier draft
 * of this gate dropped an unverified person's *content* from the file
 * entirely, silently emptying an ordinary Discord-only course's export.
 * The disclosure PPL-5 actually names is a *person's* history, and it is
 * the identity that makes a transcript one — so `apps/worker/src/handlers/transcripts.ts`
 * omits `personId`/`personDisplayName` from every entry in an unfiltered
 * export instead of dropping content by verification: every message an
 * instructor could already see on screen (ADMIN-1, unrestricted) still
 * reaches the file. A second rework finding rejected calling that file
 * "de-identified" — this platform's own conversation text routinely names
 * a student anyway (`packages/openai/src/conversations.ts`'s own opening
 * line, and a reply that echoes it back) — so the file claims only
 * `identityFieldsOmitted`, plainly, and each entry carries a `participant`
 * pseudonym, salted fresh per export, rather than nothing at all. See that
 * handler's own module comment for the reasoning in full, and
 * `docs/DECISIONS.md` D-48 for what this still trades away and the
 * objection recorded against it.
 *
 * **`transcripts.listAccessLog` (ADMIN-2).** An audit
 * (`docs/ROADMAP.md`'s "Audit — surfaces that were never built") found
 * `transcriptAccess.listAccessLogForCourse` had zero callers — the audit
 * trail `readCourseTranscript` writes to on every read or export was
 * genuinely being written, so ADMIN-2's own "is written to an audit trail"
 * held, but its "an institution has to be able to account for" did not:
 * nothing in the panel, `/admin` or MCP ever read a row back, so nobody
 * could actually account for anything.
 *
 * **Restricted to an owner**, not open to any member the way `.read`
 * itself is. This log is a different kind of disclosure than the
 * transcript content it is *about*: `.read`'s own module comment above
 * establishes that any membership may read a course's transcript, because
 * ADMIN-1 says so plainly and the read is itself the accountable event.
 * But *who else has been reading* is oversight of that same accountable
 * population, not a widening of it — ENRL-4 restricted `courseJoinLinks.revoke`
 * one way, `memberships.grant` another, and this is the same class of
 * decision `memberships.ts`'s own module comment already makes for a
 * different action: "authority over a tenant's courses, transcripts and
 * spending" is what a membership role carries, and an owner is who this
 * platform already holds accountable for a tenant's spending
 * (`costLedger.setSpendingCap`) and its staff roster (`memberships.grant`,
 * `membershipInvitations.create`) — ADMIN-2's own "an institution has to be
 * able to account for" names the same accountable party, not a course's
 * own instructor reading up on a colleague's activity. `ADMIN-4`'s "sees
 * tenants, not conversations" was also considered and rejected: a platform
 * administrator is explicitly kept out of a tenant's transcripts
 * entirely, and this log — who read whose conversation — is closer to that
 * boundary than to the usage totals ADMIN-4 actually shows, so this stays
 * on the organization-scoped panel (`pages/Transcripts.tsx`), never
 * `pages/Admin.tsx`.
 *
 * **No email, ever.** The log names two people per row — the staff member
 * who read (`actorAccountId`) and, when the read was filtered, the student
 * whose conversation it named (`personId`) — and this action resolves both
 * to a display name the same way `memberships.list`
 * (`actions/memberships.ts`) already resolves a grantor's, falling back to
 * the id itself rather than ever reading an email off either `accounts` or
 * `people` (`components/CoursePeople.tsx`'s own `displayName ?? personId`
 * precedent, `pages/Usage.tsx`'s own module comment on why this platform
 * never shows one where a display name already tells two rows apart).
 */

import {
  accounts,
  courses,
  jobs,
  memberships,
  people,
  transcriptAccess,
  transcriptExports,
} from '@bloombot/db'
import { z } from 'zod'

import { ActionConflictError, ActionRefusedError } from '../errors.js'
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
    // comment has the full reasoning). The two ways `hasVerifiedAddress`
    // can fail to say `true` are deliberately *not* collapsed into one
    // refusal here, unlike most of this platform's own checks: `undefined`
    // (the person does not exist, or belongs to another organization) is
    // TEN-5's own not-found-shaped `ActionRefusedError`, so a foreign id
    // still discloses nothing — but `false` (a real student in *this*
    // course, one the instructor already sees by name in the same filter
    // dropdown and already reads on screen, ADMIN-1) names the actual
    // reason (`ActionConflictError`, D-18's own "naming a collision is safe
    // in a way naming a not-found is not" — this caller already has full,
    // audited visibility into this student; the refusal tells them nothing
    // they could not already see). Must-fix 4 of the ADMIN-1..5 rework: a
    // plain `ActionRefusedError` here read as "not found" on a student the
    // instructor was already looking at on screen — confusing, and
    // actionably wrong, not merely uninformative.
    if (input.personId !== undefined) {
      const verified = people.hasVerifiedAddress(
        organizationId,
        input.personId,
        db
      )
      if (verified === undefined) throw new ActionRefusedError()
      if (verified === false) {
        throw new ActionConflictError({
          message:
            'This student has not verified an address yet, so their history cannot be exported individually.',
        })
      }
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

const listAccessLogInputSchema = z.object({
  courseId: z.string().min(1),
})
type ListAccessLogInput = z.infer<typeof listAccessLogInputSchema>

/** One ADMIN-2 audit row, with a display name resolved for each account it names — never an email (this file's own module comment). */
export interface TranscriptAccessLogRow {
  id: string
  actorAccountId: string
  actorDisplayName: string
  /** `null` for an unfiltered read/export across the whole course — the same "nobody in particular" case `transcriptAccessLog.personId` itself carries (`schema.ts`). */
  personId: string | null
  /** `null` exactly when `personId` is — there is no student to name a display name for. */
  personDisplayName: string | null
  kind: transcriptAccess.TranscriptAccessLogEntry['kind']
  startAt: number | null
  endAt: number | null
  createdAt: number
}

/**
 * ADMIN-2 — read a course's own transcript-access audit trail, most recent
 * first: who read (or exported) whose conversation, and when. Restricted to
 * an owner (see this file's own module comment for why), the same
 * "restricted in `execute`, not the policy" split `costLedger.setSpendingCap`
 * already takes — `PolicyContext` carries no caller identity at all
 * (`policy.ts`'s own module comment), so *who* may call this can only be
 * decided once `execute` has the real `accountId`.
 */
export const listTranscriptAccessLogAction: Action<
  'transcripts.listAccessLog',
  ListAccessLogInput,
  Course,
  TranscriptAccessLogRow[]
> = {
  name: 'transcripts.listAccessLog',
  description:
    "Read a course's transcript-access audit trail (ADMIN-2): who read or exported whose conversation, and when — most recent first. Only an existing owner may call this.",
  inputSchema: listAccessLogInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, accountId, db }) => {
    const callerAccountId = requireAccountId(accountId)
    const callerMembership = memberships.getMembership(
      organizationId,
      callerAccountId,
      db
    )
    if (!callerMembership || callerMembership.role !== 'owner') {
      throw new ActionRefusedError()
    }

    const rows = transcriptAccess.listAccessLogForCourse(
      organizationId,
      entity.id,
      db
    )
    return rows.map((row) => {
      // Every account/person id here comes off a row this file's own audit
      // trail wrote — `readCourseTranscript` (`transcript-access.ts`)
      // resolves both before writing it — but this reads each back rather
      // than trusting the reference blindly, the same discipline
      // `memberships.list`'s own `listMembershipsAction` already holds
      // itself to for the identical shape (that file's own comment).
      const actor = accounts.getAccountById(row.actorAccountId, db)
      const person = row.personId
        ? people.getPerson(organizationId, row.personId, db)
        : undefined
      return {
        id: row.id,
        actorAccountId: row.actorAccountId,
        actorDisplayName: actor?.displayName ?? row.actorAccountId,
        personId: row.personId,
        personDisplayName: row.personId
          ? (person?.displayName ?? row.personId)
          : null,
        kind: row.kind,
        startAt: row.startAt,
        endAt: row.endAt,
        createdAt: row.createdAt,
      }
    })
  },
}
