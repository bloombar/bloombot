/**
 * SRV-6: the panel's own control for scaffolding a course's Discord
 * categories and channels — exposed here for the first time. Every case
 * below is what `ScaffoldButton.tsx`'s own module comment promises: a
 * click enqueues and the button shows what state the job is actually in,
 * including "queued and no worker has claimed it yet."
 *
 * `stillQueuedHintAfterMs`/`pollIntervalMs` are overridden to a handful of
 * milliseconds throughout — real timers, real `waitFor` polling, no fake
 * timers: the component's own module comment explains why those props
 * exist at all.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { JobStatus } from '../src/api/types.js'
import { ScaffoldButton } from '../src/components/ScaffoldButton.js'

const { scaffoldCourseDiscord, getJobStatus } = vi.hoisted(() => ({
  scaffoldCourseDiscord: vi.fn(),
  getJobStatus: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, scaffoldCourseDiscord, getJobStatus }
})

function job(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    id: 'job-1',
    kind: 'discordServers.scaffold',
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

describe('ScaffoldButton (SRV-6)', () => {
  it('enqueues the job and shows it as queued', async () => {
    scaffoldCourseDiscord.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))

    render(<ScaffoldButton organizationId="org-1" courseId="course-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )

    await waitFor(() =>
      expect(scaffoldCourseDiscord).toHaveBeenCalledWith('org-1', 'course-1')
    )
    expect(await screen.findByText('Queued…')).toBeInTheDocument()
  })

  it('a job stuck pending past the hint threshold tells the person the worker might not be running', async () => {
    scaffoldCourseDiscord.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))

    render(
      <ScaffoldButton
        organizationId="org-1"
        courseId="course-1"
        pollIntervalMs={10}
        stillQueuedHintAfterMs={30}
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )
    await screen.findByText('Queued…')

    expect(
      screen.queryByText(/make sure the background worker/)
    ).not.toBeInTheDocument()

    await waitFor(() =>
      expect(
        screen.getByText(/make sure the background worker/)
      ).toBeInTheDocument()
    )
  })

  it('polling stops and the hint clears once the job succeeds', async () => {
    scaffoldCourseDiscord.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus
      .mockResolvedValueOnce(job({ status: 'pending' }))
      .mockResolvedValue(job({ status: 'succeeded' }))

    render(
      <ScaffoldButton
        organizationId="org-1"
        courseId="course-1"
        pollIntervalMs={10}
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )
    await screen.findByText('Queued…')

    expect(
      await screen.findByText('Done — categories and channels created.')
    ).toBeInTheDocument()
    // The button is enabled again — a settled job does not block a second
    // run (e.g. after fixing what a `failed` run reported).
    expect(
      screen.getByRole('button', { name: 'Create Discord channels' })
    ).not.toBeDisabled()
  })

  it('a failed job shows its own error text', async () => {
    scaffoldCourseDiscord.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({ status: 'failed', lastError: 'Discord API rate limited' })
    )

    render(<ScaffoldButton organizationId="org-1" courseId="course-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )

    expect(await screen.findByText('Failed.')).toBeInTheDocument()
    expect(screen.getByText('Discord API rate limited')).toBeInTheDocument()
  })

  it('a refused dispatch renders the same ErrorMessage every other refusal in this app uses', async () => {
    scaffoldCourseDiscord.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    render(<ScaffoldButton organizationId="org-1" courseId="course-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})
