/**
 * JOB-2 — the jobs the caller's organization has run, including one that
 * failed permanently in a session nobody has open anymore.
 *
 * An audit (`docs/ROADMAP.md`'s "Audit — surfaces that were never built")
 * found there was no *listing* anywhere in this platform: `jobs.get`
 * (`@bloombot/actions`) needs an id, and every screen that reaches it
 * (`RosterImport.tsx`, `ScaffoldButton.tsx`, `CourseAttachments.tsx`,
 * `Transcripts.tsx`) only ever holds one for a job it enqueued in the
 * *current browser session* — so a roster import that exhausted its
 * attempts yesterday was invisible to everyone, forever, even though the
 * row itself was never deleted (JOB-2's own "stays visible ... rather than
 * disappearing" held at the data layer and failed everywhere a person
 * could actually look). `api/client.ts#listJobs` (`jobs.list`) is what
 * closes that; this screen is what a caller actually sees.
 *
 * A sixth — well, seventh, after Team — tab, the same shape Usage/Team
 * already take (`pages/Shell.tsx`'s own module comment): open to any
 * member, not only an owner, the same "a read needs no extra role check"
 * reasoning `memberships.list` already gives for the identical shape
 * (`jobs.list`'s own descriptor, `resource: 'organization', access: 'read'`,
 * carries no owner-only restriction either).
 *
 * **A failed job is made legible, not merely present.** JOB-2's own text is
 * "a job that keeps failing is visible" — a plain list of `kind`/`status`
 * would satisfy that only technically, the same way the audit found the
 * *row* itself already "visible" at the data layer while nobody could
 * reach it. Each entry shows its own attempt count (`attempts` of
 * `maxAttempts`) and, once `status` is `'failed'`, the reason it stopped —
 * `lastError`, JOB-2's own "stays visible with the reason it stopped."
 * Failed is styled distinctly from pending/running (`statusIcon`/
 * `statusLabel` below), not merely a different word in the same sentence.
 */

import { useCallback, useEffect, useState } from 'react'

import { ApiError, listJobs } from '../api/client.js'
import type { JobStatus } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FailureIcon, PendingIcon, SpinnerIcon, SuccessIcon } from '../icons.js'

export interface JobsScreenProps {
  organizationId: string
}

function statusIcon(status: JobStatus['status']) {
  switch (status) {
    case 'succeeded':
      return (
        <SuccessIcon aria-hidden="true" className="size-4 text-success-600" />
      )
    case 'failed':
      return (
        <FailureIcon aria-hidden="true" className="size-4 text-danger-600" />
      )
    case 'running':
      return (
        <SpinnerIcon
          aria-hidden="true"
          className="size-4 animate-spin text-brand-600"
        />
      )
    case 'pending':
      return (
        <PendingIcon aria-hidden="true" className="size-4 text-neutral-400" />
      )
  }
}

/** A bare status code reads as jargon to an instructor checking in on the queue — the same "also-fix" `pages/Transcripts.tsx#exportStatusLabel` already applied to `TranscriptExport['status']`. */
function statusLabel(status: JobStatus['status']): string {
  switch (status) {
    case 'succeeded':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'running':
      return 'Running…'
    case 'pending':
      return 'Queued…'
  }
}

export function Jobs({ organizationId }: JobsScreenProps) {
  const [jobs, setJobs] = useState<JobStatus[] | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(undefined)
    return listJobs(organizationId).then(
      (result) => {
        setJobs(result)
        setLoading(false)
      },
      (caught: unknown) => {
        if (caught instanceof ApiError) setError(caught)
        else throw caught
        setLoading(false)
      }
    )
  }, [organizationId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <section
      aria-label="Jobs"
      data-testid="jobs-screen"
      className="flex flex-col gap-6"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-page-title font-semibold text-neutral-900">Jobs</h1>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* WEB accessibility — a live region for the one thing a screen
          reader cannot otherwise learn from this screen's own re-render:
          that a refresh finished, and how many jobs it found. The same
          `role="status"` shape `pages/Usage.tsx`'s own `statusMessage`
          already uses for an identical async-status need. */}
      <p role="status" className="sr-only">
        {loading
          ? 'Loading jobs…'
          : jobs !== undefined
            ? `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} loaded.`
            : ''}
      </p>

      {error && <ErrorMessage error={error} />}

      {jobs === undefined && !error ? (
        <p role="status" className="text-sm text-neutral-500">
          Loading…
        </p>
      ) : jobs && jobs.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No jobs have run in this organization yet.
        </p>
      ) : (
        jobs && (
          <ul className="flex flex-col gap-2" data-testid="jobs-list">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 font-medium text-neutral-900">
                    {statusIcon(job.status)}
                    {job.kind}
                  </span>
                  <span className="text-neutral-500">
                    {statusLabel(job.status)} ·{' '}
                    {new Date(job.updatedAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-neutral-500">
                  Attempt {job.attempts} of {job.maxAttempts}
                </p>
                {job.status === 'failed' && job.lastError && (
                  <p className="text-sm text-danger-700">{job.lastError}</p>
                )}
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  )
}
