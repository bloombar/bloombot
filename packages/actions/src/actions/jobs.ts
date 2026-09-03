/**
 * Read access to a job's status and outcome (JOB-1..5) — what lets a caller
 * that dispatched a job-backed action (`discordServers.scaffold`, this
 * slice's own; roster import, knowledge-file attachment or project
 * duplication in a later one) find out what happened, rather than the job
 * disappearing into the queue with no way back. This is the "way to see the
 * outcome" SRV-6..8's own brief describes: without it, dispatching a job is
 * a write into a hole nothing reads back from.
 *
 * JOB-6 — `payload` is deliberately never in what this hands back. Every
 * caller of this action that exists today (`ScaffoldButton.tsx`,
 * `RosterImport.tsx`) only ever reads `status`/`lastError`/`result`; neither
 * reads `payload` off the response, so dropping it costs nothing a real
 * caller uses. Kept off unconditionally — not merely while the row's own
 * `payload` column happens to be non-null — because a caller belonging to
 * this organization who could dispatch `roster.import` themselves could
 * already read the raw CSV they uploaded; returning it back through this
 * read action a second time, for as long as the row is still pending or
 * running, added a second way to reach the same PII this slice closes, for
 * no reader that needed it. `repos/jobs.ts`'s own `completeJob`/
 * `markJobFailed` are what actually clear the column once a job is
 * terminal; this action simply never surfaces it, terminal or not.
 *
 * **`jobs.list` (JOB-2).** An audit (`docs/ROADMAP.md`'s "Audit — surfaces
 * that were never built") found `jobs.get` was the *only* read this
 * package offered — it needs an id the caller already holds, and every
 * caller that reaches it (`RosterImport.tsx`, `ScaffoldButton.tsx`,
 * `CourseAttachments.tsx`, `Transcripts.tsx`) only ever holds one for a job
 * it enqueued in the current browser session. A roster import that
 * exhausted its attempts yesterday, in a session nobody has open anymore,
 * was therefore invisible to everyone, forever — JOB-2's own "a job that
 * keeps failing is visible" held at the data layer (the row is never
 * deleted) and failed everywhere a person could actually look.
 * `listJobsAction` closes that: every job in the caller's organization,
 * newest activity first (`repos/jobs.ts#listJobsForOrganization`'s own doc
 * comment has the ordering), reusing this file's own `toJobStatus` so a
 * listing entry and a single `jobs.get` read share exactly one mapping —
 * `payload` is absent from a listing entry for the identical reason it is
 * absent from `jobs.get`'s, not a second decision made separately for this
 * action.
 *
 * `MAX_JOBS_LIST_LIMIT`/`DEFAULT_JOBS_LIST_LIMIT` are this action's own
 * bound, not merely a suggestion `repos/jobs.ts` happens to honour — a
 * listing that returned every job an organization has ever run would grow
 * without limit as a tenant's history does, which is a different thing
 * from a screen an instructor checks in on to see what needs attention
 * today. The input schema clamps `limit` to `MAX_JOBS_LIST_LIMIT`
 * regardless of what a caller asks for, and `execute` falls back to
 * `DEFAULT_JOBS_LIST_LIMIT` when a caller asks for nothing at all.
 */

import { jobs, organizations } from '@bloombot/db'
import { z } from 'zod'

import type { Action } from '../types.js'

type Job = NonNullable<ReturnType<typeof jobs.getJob>>

const jobIdInputSchema = z.object({
  jobId: z.string().min(1),
})
type JobIdInput = z.infer<typeof jobIdInputSchema>

/** A job's status and outcome, as `jobs.get` hands it back — `result` parsed, not the raw JSON string `packages/db` stores it as, the same convenience `courses.get` gives its own caller over the repo layer's own row shape. No `payload` field (JOB-6, this file's own module comment) — what a caller was given is not the job's outcome, and this action never hands it back. */
export interface JobStatus {
  id: string
  kind: string
  status: Job['status']
  attempts: number
  maxAttempts: number
  lastError: string | null
  /** `null` until the job succeeds (or if it succeeded with nothing to report) — `undefined` would be indistinguishable from "not yet read" once this crosses a JSON boundary, so this is explicit. */
  result: unknown
  createdAt: number
  updatedAt: number
}

function toJobStatus(job: Job): JobStatus {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    result: job.result ? (JSON.parse(job.result) as unknown) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

/**
 * Read one job's status and outcome, scoped to the caller's organization
 * (ACT-2, TEN-2) — a job id belonging to another organization resolves to
 * nothing, the same as any other cross-tenant read (TEN-5).
 */
export const getJobAction: Action<'jobs.get', JobIdInput, Job, JobStatus> = {
  name: 'jobs.get',
  description:
    "Read a job's status and outcome — what a caller polls after dispatching a job-backed action such as discordServers.scaffold.",
  inputSchema: jobIdInputSchema,
  policy: {
    descriptor: { resource: 'job', access: 'read' },
    resolve: (input, context) =>
      jobs.getJob(context.organizationId, input.jobId, context.db),
  },
  execute: ({ entity }) => toJobStatus(entity),
}

type Organization = ReturnType<typeof organizations.getOrganizationById>

/** JOB-2's own bound — an instructor checking in on the queue, not a full history export. See this file's own module comment. */
const DEFAULT_JOBS_LIST_LIMIT = 50
const MAX_JOBS_LIST_LIMIT = 200

const listJobsInputSchema = z.object({
  /** How many jobs to return, newest activity first — clamped to `MAX_JOBS_LIST_LIMIT` regardless of what a caller asks for; omitted entirely, this action falls back to `DEFAULT_JOBS_LIST_LIMIT`. */
  limit: z.number().int().positive().max(MAX_JOBS_LIST_LIMIT).optional(),
})
type ListJobsInput = z.infer<typeof listJobsInputSchema>

/**
 * List the caller's organization's own jobs (JOB-2), newest activity
 * first, bounded (this file's own module comment on why, and the exact
 * bound). No existing job to resolve against on a list — the organization
 * itself is the resource, read rather than written, the same
 * "no existing record to resolve on a list" shape `projects.list`/
 * `discordServers.list` already use.
 */
export const listJobsAction: Action<
  'jobs.list',
  ListJobsInput,
  NonNullable<Organization>,
  JobStatus[]
> = {
  name: 'jobs.list',
  description:
    "List the caller's organization's own jobs (JOB-2), newest activity first, bounded by limit (default 50, max 200) — never a job's payload, the same JOB-6 guarantee jobs.get already holds.",
  inputSchema: listJobsInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'read' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, db }) => {
    const limit = input.limit ?? DEFAULT_JOBS_LIST_LIMIT
    return jobs
      .listJobsForOrganization(organizationId, limit, db)
      .map(toJobStatus)
  },
}
