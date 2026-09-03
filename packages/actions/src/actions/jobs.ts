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
 */

import { jobs } from '@bloombot/db'
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
