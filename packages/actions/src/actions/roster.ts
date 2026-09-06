/**
 * `roster.import` (ROST-9..12) — an instructor uploads the roster the
 * registrar (already merged with an intake questionnaire — see
 * `packages/schemas/src/roster.ts`'s own module comment on scope) gave
 * them, and the import runs as a job (JOB-1), because a large roster
 * outlives a request.
 *
 * As thin as `discordServers.scaffold` (`actions/discord-servers.ts`'s own
 * module comment): ACT-4's pipeline resolves the course and enqueues a job
 * (`@bloombot/db`'s own `jobs.enqueueJob`) — it never parses the CSV, never
 * touches Discord, never touches a person. All of that happens once
 * `apps/worker`'s `handlers/roster-import.ts` claims the job.
 *
 * **Text, not a file reference.** This action's input carries the roster's
 * raw CSV text (`csvText`) rather than a reference to a file stored
 * somewhere else. A roster is, in practice, a small text file — the same
 * "nothing here needs a streaming parser" reasoning
 * `packages/schemas/src/roster.ts`'s own module comment gives for hand-
 * rolling its CSV parser rather than adding a dependency — so embedding it
 * directly in the job's own `payload` (opaque JSON, `repos/jobs.ts`'s own
 * module comment) needs no blob-storage table this slice does not otherwise
 * own; `FILE-1`'s own file storage is a distinct, larger feature (a
 * knowledge-file's lifecycle, provider upload, removal — FILE-1..3) that
 * this slice's own brief names out of scope. A future upload path that
 * hands the browser a pre-signed URL instead can still enqueue the same job
 * shape with `csvText` read from wherever it landed; nothing about this
 * action's own shape forecloses that.
 *
 * **ROST-15's two extra fields, defaulted here, not in the worker.** The
 * panel's own checkbox is "checked by default" — that default lives in
 * this action, not `apps/worker`'s own handler, which treats a payload
 * omitting `createStudentCategories` as `false` (that file's own module
 * comment explains why: it is what every test of that handler predating
 * this slice still sends, and "off means today's behaviour, exactly" is
 * this slice's own requirement 5). An MCP caller that never mentions
 * either field still gets the same on-by-default behaviour an instructor
 * clicking through the panel does. `studentCategoryBaseName` defaults to
 * the course's own title plus `" - STUDENTS"` once `entity` (the resolved
 * course) is in hand — a default this action can compute and the worker
 * cannot, since `parsePayload` there runs before the course is even
 * fetched.
 */

import { courses, jobs } from '@bloombot/db'
import { z } from 'zod'

import type { Action } from '../types.js'

type Course = NonNullable<ReturnType<typeof courses.getCourse>>

// The job `kind` `apps/worker`'s `handlers/roster-import.ts` registers its
// handler under (that file's own `ROSTER_IMPORT_JOB_KIND`) — a literal
// string here too, the same cross-referenced-by-comment convention
// `discordServers.scaffold`'s own `DISCORD_SCAFFOLD_JOB_KIND` already uses:
// an app does not import from another app, and this package does not
// depend on `apps/worker`.
const ROSTER_IMPORT_JOB_KIND = 'roster.import'

// JOB-2's bound on attempts, the same reasoning
// `discordServers.scaffold`'s own `SCAFFOLD_MAX_ATTEMPTS` gives for its own
// constant (`docs/DECISIONS.md` D-29's rework finding 4: no shared default,
// each call site sets its own): room for a transient Discord failure to
// clear on retry, without a stuck job lingering indefinitely.
const ROSTER_IMPORT_MAX_ATTEMPTS = 5

const importInputSchema = z.object({
  courseId: z.string().min(1),
  // Not parsed here — `roster-import.ts`'s own `parseRosterCsv` is what
  // validates it, row by row, with each unparseable row reported by its own
  // line number (ROST-9). This action only refuses an empty upload outright,
  // which no CSV — malformed or not — could ever produce a usable report
  // from.
  csvText: z.string().min(1),
  // ROST-15 — both optional, and both defaulted below rather than by
  // `.default()` here: `createStudentCategories`'s default is a plain
  // constant, but `studentCategoryBaseName`'s needs `entity.title`, which
  // only exists once the policy has resolved the course, after schema
  // validation runs.
  createStudentCategories: z.boolean().optional(),
  studentCategoryBaseName: z.string().trim().min(1).optional(),
})
type ImportInput = z.infer<typeof importInputSchema>

/**
 * ROST-9: request that a roster be imported into a course — creating or
 * merging a person per row (ROST-10) and a private channel per student
 * (ROST-11), as a background job. Resolves the course itself (scoped to the
 * caller's organization, ACT-2) and enqueues a `roster.import` job naming
 * it; everything the job needs to reason about (the bound guild, the
 * course's student categories, the guild's own members) is
 * `apps/worker`'s own handler's concern once it claims the row, not this
 * action's — the same division `discordServers.scaffold` already holds
 * itself to.
 */
export const importRosterAction: Action<
  'roster.import',
  ImportInput,
  Course,
  { jobId: string }
> = {
  name: 'roster.import',
  description:
    'Import a roster CSV into a course (ROST-9..12): creates or merges a person per row and a private Discord channel per student, as a background job — this action enqueues the work; it does not perform it.',
  inputSchema: importInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, input, entity, db }) => {
    // ROST-15: "checked by default" (requirement 1) lives here, not in the
    // worker's own handler — see this file's own module comment.
    const createStudentCategories = input.createStudentCategories ?? true
    const studentCategoryBaseName =
      input.studentCategoryBaseName ?? `${entity.title} - STUDENTS`
    const job = jobs.enqueueJob(
      organizationId,
      {
        kind: ROSTER_IMPORT_JOB_KIND,
        payload: {
          courseId: entity.id,
          csvText: input.csvText,
          createStudentCategories,
          studentCategoryBaseName,
        },
        maxAttempts: ROSTER_IMPORT_MAX_ATTEMPTS,
      },
      db
    )
    return { jobId: job.id }
  },
}
