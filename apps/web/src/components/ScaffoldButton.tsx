/**
 * SRV-6: the control the panel was missing — running a course's Discord
 * scaffold from the browser at all. The action already existed
 * (`discordServers.scaffold`, `packages/actions`) and was already
 * reachable over HTTP (the generic action route, `apps/api`); nothing
 * before this component ever called it.
 *
 * Scaffolding is a background job (`docs/RUNNING_LOCALLY.md`'s own "the
 * worker is the one that is easy to forget: ... return a job id
 * immediately and do nothing visible until the worker runs them") — so
 * this component polls `jobs.get` and shows the job's own status rather
 * than the button appearing to do nothing the moment it is clicked. A job
 * stuck `pending` past `STILL_QUEUED_AFTER_MS` shows a hint naming the
 * worker explicitly: the whole reason this component polls instead of
 * firing and forgetting is so that exact situation — a queued job with no
 * worker running to claim it — is legible in the UI, not indistinguishable
 * from a hang.
 */

import { useEffect, useRef, useState } from 'react'

import { ApiError, getJobStatus, scaffoldCourseDiscord } from '../api/client.js'
import type { JobStatus } from '../api/types.js'
import {
  FailureIcon,
  PendingIcon,
  ScaffoldIcon,
  SpinnerIcon,
  SuccessIcon,
} from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'

export interface ScaffoldButtonProps {
  organizationId: string
  courseId: string
  /** Test-only override of `DEFAULT_STILL_QUEUED_HINT_AFTER_MS`. */
  stillQueuedHintAfterMs?: number
  /** Test-only override of `DEFAULT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number
}

/** How long a job may sit `pending` before this component says, plainly, that a background worker has to be running to claim it — generous enough that an ordinary claim delay never trips it, short enough that a genuinely stuck job does not read as a silent hang for minutes. A prop, not only a constant: `tests/scaffold-button.test.tsx` overrides both this and `pollIntervalMs` to small values so its own timing assertions run on real timers in milliseconds, not fake ones advanced past a real `setInterval`. */
const DEFAULT_STILL_QUEUED_HINT_AFTER_MS = 8_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

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
          className="size-4 animate-spin text-neutral-500"
        />
      )
    case 'pending':
      return (
        <PendingIcon aria-hidden="true" className="size-4 text-neutral-500" />
      )
  }
}

function statusLabel(status: JobStatus['status']): string {
  switch (status) {
    case 'succeeded':
      return 'Done — categories and channels created.'
    case 'failed':
      return 'Failed.'
    case 'running':
      return 'Running…'
    case 'pending':
      return 'Queued…'
  }
}

export function ScaffoldButton({
  organizationId,
  courseId,
  stillQueuedHintAfterMs = DEFAULT_STILL_QUEUED_HINT_AFTER_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: ScaffoldButtonProps) {
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState<JobStatus | undefined>(undefined)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [stillQueued, setStillQueued] = useState(false)
  const pollingSinceRef = useRef<number | undefined>(undefined)

  const settled = job?.status === 'succeeded' || job?.status === 'failed'

  useEffect(() => {
    if (!job || settled) return
    pollingSinceRef.current ??= Date.now()
    const poll = () => {
      getJobStatus(organizationId, job.id).then(
        (status) => {
          setJob(status)
          // Rework finding — gated on the *freshly fetched* status, not
          // merely elapsed time: before this, the hint was set purely from
          // how long polling had been running, so a job that spent a while
          // `pending` and then started `running` (scaffolding a dozen
          // channels through Discord's own rate limit routinely takes
          // longer than the hint threshold) kept showing "Still queued —
          // make sure the background worker is running" *while the worker
          // was demonstrably running it* — the UI claimed two contradictory
          // states at once. The hint now means only what it says: this job
          // is still `pending`, past the threshold, and nothing has claimed
          // it yet.
          setStillQueued(
            status.status === 'pending' &&
              Date.now() - (pollingSinceRef.current ?? Date.now()) >
                stillQueuedHintAfterMs
          )
        },
        (caught: unknown) => {
          if (caught instanceof ApiError) setError(caught)
          else throw caught
        }
      )
    }
    const timer = setInterval(poll, pollIntervalMs)
    return () => clearInterval(timer)
  }, [organizationId, job, settled, stillQueuedHintAfterMs, pollIntervalMs])

  useEffect(() => {
    if (settled) {
      pollingSinceRef.current = undefined
      setStillQueued(false)
    }
  }, [settled])

  const handleClick = async () => {
    setError(undefined)
    setStarting(true)
    setStillQueued(false)
    try {
      const { jobId } = await scaffoldCourseDiscord(organizationId, courseId)
      const status = await getJobStatus(organizationId, jobId)
      pollingSinceRef.current = Date.now()
      setJob(status)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setStarting(false)
    }
  }

  return (
    <div
      className="flex flex-col items-start gap-2"
      data-testid="scaffold-button"
    >
      <Button
        variant="secondary"
        icon={<ScaffoldIcon aria-hidden="true" className="size-4" />}
        onClick={() => void handleClick()}
        disabled={starting || (job !== undefined && !settled)}
      >
        {starting ? 'Starting…' : 'Create Discord channels'}
      </Button>
      {job && (
        <p
          role="status"
          className="flex items-center gap-1.5 text-sm text-neutral-700"
        >
          {statusIcon(job.status)}
          {statusLabel(job.status)}
        </p>
      )}
      {job?.status === 'failed' && job.lastError && (
        <p className="text-sm text-danger-700">{job.lastError}</p>
      )}
      {stillQueued && !settled && (
        <p role="status" className="text-sm text-warning-600">
          Still queued — make sure the background worker (
          <code>npm run worker:dev</code>) is running.
        </p>
      )}
      {error && <ErrorMessage error={error} />}
    </div>
  )
}
