/**
 * `pages/Courses.tsx` (WEB-8, PROJ-5): a project's own course list, and the
 * quick enable/disable toggle each row offers alongside the full editor.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CourseSummary, Project } from '../src/api/types.js'
import { Courses } from '../src/pages/Courses.js'

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

    render(
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

    render(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))

    await waitFor(() =>
      expect(disableCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
  })

  it('enables a disabled course from the list', async () => {
    listCourses.mockResolvedValue([{ ...COURSE, enabled: false }])
    enableCourse.mockResolvedValue({ enabled: true })

    render(
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

  it('opening "New course" hands undefined up, opening an existing one hands its id up', async () => {
    listCourses.mockResolvedValue([COURSE])
    const onOpenCourse = vi.fn()

    render(
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
