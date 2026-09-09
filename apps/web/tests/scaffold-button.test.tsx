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

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type {
  DiscordServerBindingSummary,
  JobStatus,
} from '../src/api/types.js'
import { ScaffoldButton } from '../src/components/ScaffoldButton.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { scaffoldCourseDiscord, getJobStatus, listDiscordServers } = vi.hoisted(
  () => ({
    scaffoldCourseDiscord: vi.fn(),
    getJobStatus: vi.fn(),
    listDiscordServers: vi.fn(),
  })
)

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, scaffoldCourseDiscord, getJobStatus, listDiscordServers }
})

function binding(
  overrides: Partial<DiscordServerBindingSummary> = {}
): DiscordServerBindingSummary {
  return {
    serverId: 'guild-1',
    organizationId: 'org-1',
    installedByAccountId: 'account-1',
    installedAt: Date.now(),
    removedAt: null,
    ...overrides,
  }
}

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
  beforeEach(() => {
    // Every pre-existing case below is the regression this default covers:
    // an organization with an active binding scaffolds exactly as it
    // always has. The no-binding cases override this explicitly.
    listDiscordServers.mockResolvedValue([binding()])
  })

  it('enqueues the job and shows it as queued', async () => {
    scaffoldCourseDiscord.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))

    renderWithModal(
      <ScaffoldButton organizationId="org-1" courseId="course-1" />
    )
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

    renderWithModal(
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

  // Rework finding — the hint is gated on the job's own *current* status,
  // not merely elapsed time: a job that took a while `pending` and then
  // started `running` (scaffolding a dozen channels through Discord's own
  // rate limit routinely takes longer than the hint threshold) must not
  // keep showing "the worker might not be running" once the worker
  // demonstrably is — the UI must not claim two contradictory states at
  // once.
  it('a job that transitions from pending to running before the hint threshold never shows the hint, even once elapsed time alone would cross it', async () => {
    scaffoldCourseDiscord.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus
      .mockResolvedValueOnce(job({ status: 'pending' }))
      .mockResolvedValue(job({ status: 'running' }))

    renderWithModal(
      <ScaffoldButton
        organizationId="org-1"
        courseId="course-1"
        pollIntervalMs={10}
        stillQueuedHintAfterMs={20}
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )
    await screen.findByText('Queued…')
    await screen.findByText('Running…')

    // Give several poll intervals — comfortably past the hint threshold —
    // a chance to run while the job stays `running`.
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(
      screen.queryByText(/make sure the background worker/)
    ).not.toBeInTheDocument()
  })

  it('polling stops and the hint clears once the job succeeds', async () => {
    scaffoldCourseDiscord.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus
      .mockResolvedValueOnce(job({ status: 'pending' }))
      .mockResolvedValue(job({ status: 'succeeded' }))

    renderWithModal(
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

    renderWithModal(
      <ScaffoldButton organizationId="org-1" courseId="course-1" />
    )
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

    renderWithModal(
      <ScaffoldButton organizationId="org-1" courseId="course-1" />
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  // Bug 1 — clicking "Create Discord channels" with no Discord server
  // connected used to enqueue the job anyway, which then failed minutes
  // later deep in the worker (`discord-scaffold.ts`'s own "...has no
  // active Discord server bound"). These cover the click-time guard
  // instead: no active binding means a confirmation, never a job.
  describe('no active Discord server binding', () => {
    it('opens a confirmation instead of enqueueing, and confirming calls onConnectDiscord', async () => {
      listDiscordServers.mockResolvedValue([])
      const onConnectDiscord = vi.fn()

      renderWithModal(
        <ScaffoldButton
          organizationId="org-1"
          courseId="course-1"
          onConnectDiscord={onConnectDiscord}
        />
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Create Discord channels' })
      )

      const dialog = await screen.findByRole('dialog', {
        name: 'Connect a Discord server first',
      })
      // No job enqueued while the confirmation is open.
      expect(scaffoldCourseDiscord).not.toHaveBeenCalled()

      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Connect a server' })
      )

      await waitFor(() => expect(onConnectDiscord).toHaveBeenCalled())
      expect(scaffoldCourseDiscord).not.toHaveBeenCalled()
    })

    it('a binding whose removedAt is set counts as not connected', async () => {
      listDiscordServers.mockResolvedValue([binding({ removedAt: Date.now() })])
      const onConnectDiscord = vi.fn()

      renderWithModal(
        <ScaffoldButton
          organizationId="org-1"
          courseId="course-1"
          onConnectDiscord={onConnectDiscord}
        />
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Create Discord channels' })
      )

      await screen.findByRole('dialog', {
        name: 'Connect a Discord server first',
      })
      expect(scaffoldCourseDiscord).not.toHaveBeenCalled()
    })

    it('cancelling calls neither scaffoldCourseDiscord nor onConnectDiscord', async () => {
      listDiscordServers.mockResolvedValue([])
      const onConnectDiscord = vi.fn()

      renderWithModal(
        <ScaffoldButton
          organizationId="org-1"
          courseId="course-1"
          onConnectDiscord={onConnectDiscord}
        />
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Create Discord channels' })
      )

      const dialog = await screen.findByRole('dialog', {
        name: 'Connect a Discord server first',
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', {
            name: 'Connect a Discord server first',
          })
        ).not.toBeInTheDocument()
      )
      expect(onConnectDiscord).not.toHaveBeenCalled()
      expect(scaffoldCourseDiscord).not.toHaveBeenCalled()
    })
  })
})
