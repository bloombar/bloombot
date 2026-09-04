/**
 * `pages/Courses.tsx` (WEB-8, PROJ-5): a project's own course list, the
 * quick enable/disable toggle each row offers behind its own kebab menu
 * (WEB-26), and its own Chat button (WEB-28).
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
  discordServerId: null,
  createdAt: 0,
}

/** Opens a course row's own kebab menu, by its own `aria-label` (WEB-26) — every menu item test below goes through this rather than reaching the item directly, so it also proves the item is actually reachable behind the row's own control. */
function openCourseMenu(courseTitle: string) {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for "${courseTitle}"` })
  )
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
        onOpenChat={vi.fn()}
      />
    )

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(listCourses).toHaveBeenCalledWith('org-1', 'project-1')
  })

  // WEB-26: Disable/Enable moved behind the row's own kebab menu — this
  // pins that the item is reachable *there*, not merely that the text
  // "Disable" exists somewhere on the page.
  it('disables an enabled course from its kebab menu, without opening the editor', async () => {
    listCourses.mockResolvedValue([COURSE])
    disableCourse.mockResolvedValue({ disabled: true })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    openCourseMenu('Web Design')
    const menu = screen.getByRole('group', { name: 'Actions for "Web Design"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Disable' }))
    // WEB-15: destructive, so it confirms first (`components/modal/`).
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }))

    await waitFor(() =>
      expect(disableCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
  })

  it('enables a disabled course from its kebab menu', async () => {
    listCourses.mockResolvedValue([{ ...COURSE, enabled: false }])
    enableCourse.mockResolvedValue({ enabled: true })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    openCourseMenu('Web Design')
    const menu = screen.getByRole('group', { name: 'Actions for "Web Design"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Enable' }))

    await waitFor(() =>
      expect(enableCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
  })

  // WEB-28: the row's own Chat button hands the course id straight up —
  // `pages/Shell.tsx`'s own tests cover what happens once it reaches the
  // shell (landing on the Chat tab with this course selected).
  it('clicking Chat on a course row hands its id up to onOpenChat', async () => {
    listCourses.mockResolvedValue([COURSE])
    const onOpenChat = vi.fn()

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={onOpenChat}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(
      screen.getByRole('button', { name: 'Chat about "Web Design"' })
    )

    expect(onOpenChat).toHaveBeenCalledWith('course-1')
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
        onOpenChat={vi.fn()}
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
          onOpenChat={vi.fn()}
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
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'New course' }))
    expect(onOpenCourse).toHaveBeenCalledWith(undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Web Design' }))
    expect(onOpenCourse).toHaveBeenCalledWith('course-1')
  })
})
