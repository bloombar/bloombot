/**
 * `pages/Courses.tsx` (WEB-8, PROJ-5): a project's own course list, and the
 * quick enable/disable toggle each row offers alongside the full editor.
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CourseSummary, Project } from '../src/api/types.js'
import { Courses } from '../src/pages/Courses.js'
import { renderWithModal, withModal } from './helpers/render-with-modal.js'

const { listCourses, enableCourse, disableCourse } = vi.hoisted(() => ({
  listCourses: vi.fn(),
  enableCourse: vi.fn(),
  disableCourse: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, listCourses, enableCourse, disableCourse }
})

const PROJECT: Project = {
  id: 'project-1',
  organizationId: 'org-1',
  name: 'Fall 2026',
  archivedAt: null,
  createdAt: 0,
}

const COURSE: CourseSummary = {
  id: 'course-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  title: 'Web Design',
  filePrefix: 'wd',
  enabled: true,
  adminsRole: 'admins-wd-fa26',
  studentsRole: 'students-wd-fa26',
  promptId: null,
  instructions: 'Be helpful.',
  model: null,
  vectorStoreId: null,
  maxRequestsPerDay: null,
  conversationScope: 'course',
  createdAt: 0,
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('Courses (WEB-8)', () => {
  it("lists the project's courses, scoped by projectId", async () => {
    listCourses.mockResolvedValue([COURSE])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
      />
    )

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(listCourses).toHaveBeenCalledWith('org-1', 'project-1')
  })

  it('disables an enabled course from the list, without opening the editor', async () => {
    listCourses.mockResolvedValue([COURSE])
    disableCourse.mockResolvedValue({ disabled: true })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    // WEB-15: destructive, so it confirms first (`components/modal/`).
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }))

    await waitFor(() =>
      expect(disableCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
  })

  it('enables a disabled course from the list', async () => {
    listCourses.mockResolvedValue([{ ...COURSE, enabled: false }])
    enableCourse.mockResolvedValue({ enabled: true })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    await waitFor(() =>
      expect(enableCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
  })

  it('a stale, out-of-order response for a superseded project cannot overwrite the current one (finding 8 of the WEB-7 rework)', async () => {
    let resolveFirst: (value: CourseSummary[]) => void = () => {}
    let resolveSecond: (value: CourseSummary[]) => void = () => {}
    listCourses
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )

    const { rerender } = renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
      />
    )
    const otherProject: Project = {
      ...PROJECT,
      id: 'project-2',
      name: 'Spring 2027',
    }
    rerender(
      withModal(
        <Courses
          organizationId="org-1"
          project={otherProject}
          onBack={vi.fn()}
          onOpenCourse={vi.fn()}
        />
      )
    )

    // The *second* request (for the now-current project) resolves first,
    // and the superseded first request resolves after it — exactly the
    // out-of-order case `refreshId` exists to guard against.
    resolveSecond([{ ...COURSE, id: 'course-2', title: 'Spring Course' }])
    await screen.findByText('Spring Course')
    resolveFirst([COURSE])
    // Flush the microtask queue so the stale response's `.then` — the one
    // that must be ignored — has a chance to run before this asserts.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('Spring Course')).toBeInTheDocument()
    expect(screen.queryByText('Web Design')).not.toBeInTheDocument()
  })

  it('opening "New course" hands undefined up, opening an existing one hands its id up', async () => {
    listCourses.mockResolvedValue([COURSE])
    const onOpenCourse = vi.fn()

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={onOpenCourse}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'New course' }))
    expect(onOpenCourse).toHaveBeenCalledWith(undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Web Design' }))
    expect(onOpenCourse).toHaveBeenCalledWith('course-1')
  })
})
