/**
 * `components/CoursePeople.tsx` (WEB-22): the screen a course's people were
 * missing entirely. Every case below is what that component's own module
 * comment promises: two distinct lists (never one status column), how each
 * person was admitted, ending behind a confirmation stating both halves of
 * ENRL-6, reinstating (ENRL-9) with no confirmation at all, and never a
 * person's email.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseEnrolment } from '../src/api/types.js'
import { CoursePeople } from '../src/components/CoursePeople.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { listCourseEnrolments, endCourseEnrolment, reinstateCourseEnrolment } =
  vi.hoisted(() => ({
    listCourseEnrolments: vi.fn(),
    endCourseEnrolment: vi.fn(),
    reinstateCourseEnrolment: vi.fn(),
  }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listCourseEnrolments,
    endCourseEnrolment,
    reinstateCourseEnrolment,
  }
})

function entry(overrides: Partial<CourseEnrolment> = {}): CourseEnrolment {
  return {
    id: 'enrolment-1',
    personId: 'person-1',
    displayName: 'Ada Lovelace',
    source: 'roster',
    createdAt: Date.now(),
    endedAt: null,
    reinstatedByAccountId: null,
    reinstatedAt: null,
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('CoursePeople (WEB-22)', () => {
  it('shows the empty state for both lists when a course has no enrolments', async () => {
    listCourseEnrolments.mockResolvedValue([])

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)

    expect(
      await screen.findByText('Nobody is enrolled yet.')
    ).toBeInTheDocument()
    expect(
      screen.getByText("Nobody's enrolment has ended.")
    ).toBeInTheDocument()
  })

  it('lists an active enrolment under "Enrolled", with how it was admitted, and offers only End', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({ id: 'e1', source: 'discord_role' }),
    ])

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText(/Discord role/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    ).not.toBeInTheDocument()
  })

  it('lists an ended enrolment under "Enrolment ended", with how it was admitted, and offers only Reinstate', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({ id: 'e1', source: 'join_link', endedAt: Date.now() }),
    ])

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByText(/Join link/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: "End Ada Lovelace's enrolment" })
    ).not.toBeInTheDocument()
  })

  // WEB-22: "do not display a person's email unless the screen genuinely
  // needs it to disambiguate" — a `null` displayName falls back to
  // `personId`, never to `entry.email` (which this component's own props
  // never even carry).
  it('falls back to the person id, never an email, when displayName is null', async () => {
    listCourseEnrolments.mockResolvedValue([
      entry({ id: 'e1', personId: 'person-42', displayName: null }),
    ])

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)

    expect(await screen.findByText('person-42')).toBeInTheDocument()
  })

  it('ending confirms first, stating both halves of ENRL-6 — cancelling calls nothing', async () => {
    listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    )
    const dialog = await screen.findByRole('dialog', {
      name: "End Ada Lovelace's enrolment?",
    })
    expect(dialog).toHaveTextContent('This stops them asking this course')
    expect(dialog).toHaveTextContent('does not delete their transcript')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(endCourseEnrolment).not.toHaveBeenCalled()
  })

  it('ending, confirmed, dispatches enrolments.end and the person moves to "Enrolment ended"', async () => {
    listCourseEnrolments
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: null })])
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: Date.now() })])
    endCourseEnrolment.mockResolvedValue({ ended: true })

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    )
    const dialog = await screen.findByRole('dialog', {
      name: "End Ada Lovelace's enrolment?",
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'End enrolment' })
    )

    await waitFor(() =>
      expect(endCourseEnrolment).toHaveBeenCalledWith('org-1', 'e1')
    )
    expect(
      await screen.findByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: "End Ada Lovelace's enrolment" })
    ).not.toBeInTheDocument()
  })

  // ENRL-9: reinstating grants access back, so it runs with no confirmation
  // at all — unlike ending, there is no dialog to find here.
  it('reinstating dispatches enrolments.reinstate immediately, with no confirmation, and the person moves back to "Enrolled"', async () => {
    listCourseEnrolments
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: Date.now() })])
      .mockResolvedValueOnce([entry({ id: 'e1', endedAt: null })])
    reinstateCourseEnrolment.mockResolvedValue({ reinstated: true })

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', {
        name: "Reinstate Ada Lovelace's enrolment",
      })
    )

    await waitFor(() =>
      expect(reinstateCourseEnrolment).toHaveBeenCalledWith('org-1', 'e1')
    )
    expect(
      await screen.findByRole('button', {
        name: "End Ada Lovelace's enrolment",
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a refused end renders the same ErrorMessage every other refusal in this app uses', async () => {
    listCourseEnrolments.mockResolvedValue([entry({ id: 'e1' })])
    endCourseEnrolment.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(<CoursePeople organizationId="org-1" courseId="course-1" />)
    await screen.findByText('Ada Lovelace')

    fireEvent.click(
      screen.getByRole('button', { name: "End Ada Lovelace's enrolment" })
    )
    const dialog = await screen.findByRole('dialog', {
      name: "End Ada Lovelace's enrolment?",
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'End enrolment' })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})
