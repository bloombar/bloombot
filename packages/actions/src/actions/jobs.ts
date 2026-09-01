/**
 * Read access to a job's status and outcome (JOB-1..5) — what lets a caller
 * that dispatched a job-backed action (`discordServers.scaffold`, this
 * slice's own; roster import, knowledge-file attachment or project
 * duplication in a later one) find out what happened, rather than the job
 * disappearing into the queue with no way back. This is the "way to see the
 * outcome" SRV-6..8's own brief describes: without it, dispatching a job is
 * a write into a hole nothing reads back from.
 */

import { jobs } from '@bloombot/db'
import { z } from 'zod'

import type { Action } from '../types.js'

type Job = NonNullable<ReturnType<typeof jobs.getJob>>

const jobIdInputSchema = z.object({
  jobId: z.string().min(1),
})
type JobIdInput = z.infer<typeof jobIdInputSchema>

/** A job's status and outcome, as `jobs.get` hands it back — `payload`/`result` parsed, not the raw JSON string `packages/db` stores them as, the same convenience `courses.get` gives its own caller over the repo layer's own row shape. */
export interface JobStatus {
  id: string
  kind: string
  status: Job['status']
  attempts: number
  maxAttempts: number
  lastError: string | null
  payload: unknown
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
    payload: JSON.parse(job.payload) as unknown,
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
