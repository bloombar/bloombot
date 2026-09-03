/**
 * `components/JoinLinks.tsx` (WEB-20): the screen a course's join links
 * were missing entirely. Every case below is what that component's own
 * module comment promises: a created secret shown exactly once with a copy
 * control, a list that never repeats it, and a revoke that confirms first
 * and states both halves of ENRL-4.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseJoinLinkSummary } from '../src/api/types.js'
import { JoinLinks } from '../src/components/JoinLinks.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { createCourseJoinLink, listCourseJoinLinks, revokeCourseJoinLink } =
  vi.hoisted(() => ({
    createCourseJoinLink: vi.fn(),
    listCourseJoinLinks: vi.fn(),
    revokeCourseJoinLink: vi.fn(),
  }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    createCourseJoinLink,
    listCourseJoinLinks,
    revokeCourseJoinLink,
  }
})

function link(
  overrides: Partial<CourseJoinLinkSummary> = {}
): CourseJoinLinkSummary {
  return {
    id: 'link-1',
    courseId: 'course-1',
    expiresAt: null,
    revokedAt: null,
    createdByAccountId: 'account-1',
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  // jsdom carries no `navigator.clipboard` by default — stubbed here so
  // `handleCopy` has something real to call, and so tests below can assert
  // the exact URL it was called with.
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('JoinLinks (WEB-20)', () => {
  it('shows the empty state when a course has no join links', async () => {
    listCourseJoinLinks.mockResolvedValue([])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    expect(
      await screen.findByText('No join links issued yet.')
    ).toBeInTheDocument()
  })

  it('lists each link with its expiry and revoked state', async () => {
    listCourseJoinLinks.mockResolvedValue([
      link({ id: 'link-1', expiresAt: null, revokedAt: null }),
      link({ id: 'link-2', expiresAt: Date.now() + 100_000, revokedAt: null }),
      link({ id: 'link-3', expiresAt: null, revokedAt: Date.now() }),
    ])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    expect(await screen.findByText('No expiry')).toBeInTheDocument()
    expect(screen.getByText(/^Expires /)).toBeInTheDocument()
    expect(screen.getByText(/^Revoked /)).toBeInTheDocument()
    // A revoked link offers no revoke control of its own.
    expect(
      screen.queryAllByRole('button', { name: /^Revoke join link/ })
    ).toHaveLength(2)
  })

  // Fails without the fix: before `courseJoinLinks.list` existed, this
  // component had nothing to call and nothing to render here at all.
  it('creating shows the secret exactly once, with a control that copies it — the list never repeats it', async () => {
    listCourseJoinLinks
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([link({ id: 'link-1' })])
    createCourseJoinLink.mockResolvedValue({
      linkId: 'link-1',
      secret: 'the-secret-value',
      expiresAt: null,
    })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')

    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

    await waitFor(() =>
      expect(createCourseJoinLink).toHaveBeenCalledWith('org-1', 'course-1')
    )
    const urlNode = await screen.findByTestId('created-join-link-url')
    expect(urlNode).toHaveTextContent('/join/the-secret-value')
    expect(screen.getByText(/shown only this once/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('/join/the-secret-value')
      )
    )

    // The list itself — read back from `courseJoinLinks.list` — never
    // carries anything secret-shaped; only the one-time banner above does.
    const list = await screen.findByRole('list')
    expect(within(list).queryByText(/the-secret-value/)).not.toBeInTheDocument()
  })

  // "Not re-fetchable after a reload" — a fresh mount of this same
  // component (standing in for a reload, which always remounts React state
  // from scratch) has never seen the secret and has no route back to it: it
  // reads only `courseJoinLinks.list`, which never carries one.
  it('a fresh mount never shows a secret, even for a link this session already created', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)

    await screen.findByText(/^Created /)
    expect(
      screen.queryByTestId('created-join-link-url')
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/shown only this once/)).not.toBeInTheDocument()
  })

  it('revoking confirms first, stating both halves of ENRL-4 — cancelling calls nothing', async () => {
    listCourseJoinLinks.mockResolvedValue([link({ id: 'link-1' })])

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)

    fireEvent.click(screen.getByRole('button', { name: /^Revoke join link/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke this join link?',
    })
    expect(dialog).toHaveTextContent('stops the link admitting anyone new')
    expect(dialog).toHaveTextContent('does not un-enrol anybody')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(revokeCourseJoinLink).not.toHaveBeenCalled()
  })

  it('revoking, confirmed, dispatches the action and the link reads as revoked', async () => {
    listCourseJoinLinks
      .mockResolvedValueOnce([link({ id: 'link-1', revokedAt: null })])
      .mockResolvedValue([link({ id: 'link-1', revokedAt: Date.now() })])
    revokeCourseJoinLink.mockResolvedValue({ revoked: true })

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText(/^Created /)

    fireEvent.click(screen.getByRole('button', { name: /^Revoke join link/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke this join link?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(revokeCourseJoinLink).toHaveBeenCalledWith('org-1', 'link-1')
    )
    expect(await screen.findByText(/^Revoked /)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Revoke join link/ })
    ).not.toBeInTheDocument()
  })

  it('a refused create renders the same ErrorMessage every other refusal in this app uses', async () => {
    listCourseJoinLinks.mockResolvedValue([])
    createCourseJoinLink.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(<JoinLinks organizationId="org-1" courseId="course-1" />)
    await screen.findByText('No join links issued yet.')

    fireEvent.click(screen.getByRole('button', { name: 'Create join link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})
