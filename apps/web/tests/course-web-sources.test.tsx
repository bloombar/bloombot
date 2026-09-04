/**
 * `components/CourseWebSources.tsx` (FILE-6, MDL-9, WEB-31): the screen a
 * course's websites were missing entirely. Every case below is what that
 * component's own module comment promises: an add (typed as a full URL, to
 * prove the reduced-domain result is what actually renders), a listing, a
 * refused duplicate surfaced rather than swallowed, and a confirmed
 * remove — mirroring `course-attachments.test.tsx`'s own shape.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseWebSourceSummary } from '../src/api/types.js'
import { CourseWebSources } from '../src/components/CourseWebSources.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { listCourseWebSources, addCourseWebSource, removeCourseWebSource } =
  vi.hoisted(() => ({
    listCourseWebSources: vi.fn(),
    addCourseWebSource: vi.fn(),
    removeCourseWebSource: vi.fn(),
  }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listCourseWebSources,
    addCourseWebSource,
    removeCourseWebSource,
  }
})

function webSource(
  overrides: Partial<CourseWebSourceSummary> = {}
): CourseWebSourceSummary {
  return {
    id: 'src-1',
    courseId: 'course-1',
    domain: 'example.edu',
    createdAt: Date.now(),
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('CourseWebSources (FILE-6)', () => {
  it('shows the empty state when a course has no websites', async () => {
    listCourseWebSources.mockResolvedValue([])

    renderWithModal(
      <CourseWebSources organizationId="org-1" courseId="course-1" />
    )

    expect(
      await screen.findByText('No websites added yet.')
    ).toBeInTheDocument()
  })

  it('lists each website by its own domain', async () => {
    listCourseWebSources.mockResolvedValue([
      webSource({ id: 'src-1', domain: 'example.edu' }),
      webSource({ id: 'src-2', domain: 'docs.python.org' }),
    ])

    renderWithModal(
      <CourseWebSources organizationId="org-1" courseId="course-1" />
    )

    expect(await screen.findByText('example.edu')).toBeInTheDocument()
    expect(screen.getByText('docs.python.org')).toBeInTheDocument()
  })

  // WEB-31: typed as a full URL — the panel renders back whatever the
  // action actually stored (the reduced, bare domain), never the string an
  // instructor typed.
  it('adding a full URL shows the reduced bare domain the action returned, not the typed string', async () => {
    listCourseWebSources
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([webSource({ domain: 'example.edu' })])
    addCourseWebSource.mockResolvedValue(webSource({ domain: 'example.edu' }))

    renderWithModal(
      <CourseWebSources organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No websites added yet.')

    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'https://Example.edu/some/path' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add website' }))

    await waitFor(() => expect(addCourseWebSource).toHaveBeenCalledTimes(1))
    expect(addCourseWebSource).toHaveBeenCalledWith(
      'org-1',
      'course-1',
      'https://Example.edu/some/path'
    )

    expect(await screen.findByText('example.edu')).toBeInTheDocument()
    expect(
      screen.queryByText('https://Example.edu/some/path')
    ).not.toBeInTheDocument()
  })

  it('adding a domain the course already names surfaces the refusal, not a duplicate row', async () => {
    listCourseWebSources.mockResolvedValue([])
    addCourseWebSource.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: {
          message: '"example.edu" is already a website this course names.',
        },
      })
    )

    renderWithModal(
      <CourseWebSources organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No websites added yet.')

    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add website' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('No websites added yet.')).toBeInTheDocument()
  })

  // MDL-9/MAX_COURSE_WEB_SOURCES — a course at OpenAI's own 100-domain cap
  // refuses the same way a duplicate does: surfaced through the existing
  // `ErrorMessage` path, no new UI affordance.
  it('adding past the course own website cap surfaces the refusal', async () => {
    listCourseWebSources.mockResolvedValue([])
    addCourseWebSource.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: {
          message:
            'This course already names 100 websites, the most a single course may ground its answers in.',
        },
      })
    )

    renderWithModal(
      <CourseWebSources organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No websites added yet.')

    fireEvent.change(screen.getByLabelText('Website'), {
      target: { value: 'one-too-many.example.edu' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add website' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This course already names 100 websites')
    expect(screen.getByText('No websites added yet.')).toBeInTheDocument()
  })

  it('remove confirms first — cancelling leaves the website exactly as it was', async () => {
    listCourseWebSources.mockResolvedValue([
      webSource({ domain: 'example.edu' }),
    ])

    renderWithModal(
      <CourseWebSources organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('example.edu')

    fireEvent.click(screen.getByRole('button', { name: 'Remove example.edu' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove "example.edu"?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(removeCourseWebSource).not.toHaveBeenCalled()
    expect(screen.getByText('example.edu')).toBeInTheDocument()
  })

  it('remove, confirmed, dispatches the action and the row disappears', async () => {
    listCourseWebSources
      .mockResolvedValueOnce([
        webSource({ id: 'src-1', domain: 'example.edu' }),
      ])
      .mockResolvedValue([])
    removeCourseWebSource.mockResolvedValue({ removed: true })

    renderWithModal(
      <CourseWebSources organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('example.edu')

    fireEvent.click(screen.getByRole('button', { name: 'Remove example.edu' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove "example.edu"?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(removeCourseWebSource).toHaveBeenCalledWith('org-1', 'src-1')
    )
    expect(
      await screen.findByText('No websites added yet.')
    ).toBeInTheDocument()
  })
})
