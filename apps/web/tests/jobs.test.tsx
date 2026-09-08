/**
 * `pages/Jobs.tsx` (JOB-2): the caller's organization's own jobs, newest
 * activity first — a failed job made legible (its own attempt count, and
 * the reason it stopped), distinct from one still pending or running.
 */

import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { JobStatus } from '../src/api/types.js'
import { Jobs } from '../src/pages/Jobs.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { listJobs } = vi.hoisted(() => ({ listJobs: vi.fn() }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, listJobs }
})

function job(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    id: 'job-1',
    kind: 'roster.import',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('Jobs (JOB-2)', () => {
  it('shows "no jobs" once the organization has never run one', async () => {
    listJobs.mockResolvedValue([])

    renderWithModal(<Jobs organizationId="org-1" />)

    expect(
      await screen.findByText('No jobs have run in this organization yet.')
    ).toBeInTheDocument()
  })

  // This is JOB-2's own defect, proved at this screen: a job that
  // exhausted its attempts is not merely present in the list — its own
  // attempt count and the reason it stopped are both legible, and neither
  // requires this browser to have been the one that dispatched it (this
  // test seeds no dispatch at all, only the listing response).
  it('shows a permanently failed job with its own attempt count and error, distinctly from a pending one', async () => {
    listJobs.mockResolvedValue([
      job({
        id: 'job-failed',
        kind: 'roster.import',
        status: 'failed',
        attempts: 5,
        maxAttempts: 5,
        lastError: 'exhausted attempts: upstream timed out',
      }),
      job({ id: 'job-pending', kind: 'discordServers.scaffold' }),
    ])

    renderWithModal(<Jobs organizationId="org-1" />)

    expect(await screen.findByText(/^Failed ·/)).toBeInTheDocument()
    expect(
      screen.getByText('exhausted attempts: upstream timed out')
    ).toBeInTheDocument()
    expect(screen.getByText('Attempt 5 of 5')).toBeInTheDocument()
    // The pending job carries no error text at all.
    expect(screen.getByText(/^Queued… ·/)).toBeInTheDocument()
    expect(screen.getByText('Attempt 0 of 5')).toBeInTheDocument()
  })

  it('a running job reads distinctly from both pending and failed', async () => {
    listJobs.mockResolvedValue([job({ status: 'running', attempts: 1 })])

    renderWithModal(<Jobs organizationId="org-1" />)

    expect(await screen.findByText(/^Running… ·/)).toBeInTheDocument()
    expect(screen.queryByText(/^Failed ·/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Queued… ·/)).not.toBeInTheDocument()
  })

  it('never renders a payload field, even if one somehow reached the response', async () => {
    listJobs.mockResolvedValue([
      // `JobStatus` declares no `payload` field at all (JOB-6) — cast past
      // the type to prove this screen would not render one even if a
      // future rework widened the response, the same defensive shape
      // `roster-import.test.tsx`'s own JOB-6 coverage takes at the panel
      // layer.
      {
        ...job(),
        payload: JSON.stringify({ csvText: 'Ada,ada@example.edu' }),
      } as JobStatus,
    ])

    renderWithModal(<Jobs organizationId="org-1" />)

    await screen.findByText(/^Queued… ·/)
    expect(screen.queryByText(/ada@example\.edu/)).not.toBeInTheDocument()
  })

  it('a failed load renders the same ErrorMessage every other refusal in this app uses', async () => {
    listJobs.mockRejectedValue(new ApiError(500, { error: 'internal_error' }))

    renderWithModal(<Jobs organizationId="org-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.'
    )
  })

  it('Refresh re-fetches the listing', async () => {
    listJobs.mockResolvedValue([])

    renderWithModal(<Jobs organizationId="org-1" />)
    await screen.findByText('No jobs have run in this organization yet.')

    listJobs.mockClear()
    screen.getByRole('button', { name: 'Refresh' }).click()

    await waitFor(() => expect(listJobs).toHaveBeenCalledWith('org-1'))
  })
})
