/**
 * `pages/Courses.tsx` (WEB-8, PROJ-5): a project's own course list, the
 * quick enable/disable toggle each row offers behind its own kebab menu
 * (WEB-26), and its own Chat button (WEB-28).
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseSummary, Project } from '../src/api/types.js'
import { Courses } from '../src/pages/Courses.js'
import { renderWithModal, withModal } from './helpers/render-with-modal.js'

const {
  listCourses,
  enableCourse,
  disableCourse,
  exportCourse,
  downloadTextFile,
  previewDeleteCourse,
  deleteCourse,
  // WEB-61 — `Courses` now carries the project's own kebab too
  // (`hooks/useProjectMenu.tsx`), so every test in this file needs these
  // mocked, not only the ones below that assert on them.
  archiveProject,
  unarchiveProject,
  renameProject,
  duplicateProject,
  previewDeleteProject,
  deleteProject,
} = vi.hoisted(() => ({
  listCourses: vi.fn(),
  enableCourse: vi.fn(),
  disableCourse: vi.fn(),
  exportCourse: vi.fn(),
  downloadTextFile: vi.fn(),
  previewDeleteCourse: vi.fn(),
  deleteCourse: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  renameProject: vi.fn(),
  duplicateProject: vi.fn(),
  previewDeleteProject: vi.fn(),
  deleteProject: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listCourses,
    enableCourse,
    disableCourse,
    exportCourse,
    downloadTextFile,
    previewDeleteCourse,
    deleteCourse,
    archiveProject,
    unarchiveProject,
    renameProject,
    duplicateProject,
    previewDeleteProject,
    deleteProject,
  }
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
  enabled: true,
  adminsRole: 'admins-wd-fa26',
  studentsRole: 'students-wd-fa26',
  promptId: null,
  instructions: 'Be helpful.',
  model: null,
  vectorStoreId: null,
  maxRequestsPerDay: null,
  conversationScope: 'course',
  selfEnrolFromDiscord: false,
  answerUnenrolled: true,
  discordServerId: null,
  createdAt: 0,
  aiApprovedAt: 1000,
}

/** WEB-61 — opens the project's own kebab menu (distinct from a course row's own, above, by name: the project's is named after `project.name`, never a course title). */
function openProjectMenu(projectName: string) {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for "${projectName}"` })
  )
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
        onProjectChanged={vi.fn()}
      />
    )

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(listCourses).toHaveBeenCalledWith('org-1', 'project-1')
  })

  // PROJ-7: a role-less course's own metadata line must read sensibly
  // rather than printing an empty `<code>` tag either role's absence
  // would otherwise leave behind. Fails without the fix: the row used to
  // render "routes on roles [empty] / [empty]" for a course naming
  // neither.
  it("a role-less course's row says it does not route on a role, rather than showing empty role tags", async () => {
    const roleless: CourseSummary = {
      ...COURSE,
      adminsRole: null,
      studentsRole: null,
    }
    listCourses.mockResolvedValue([roleless])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(screen.getByText(/does not route on a role/)).toBeInTheDocument()
    expect(screen.queryByText('admins-wd-fa26')).not.toBeInTheDocument()
    expect(screen.queryByText('students-wd-fa26')).not.toBeInTheDocument()
  })

  // A course naming only one of the two roles still shows that one, rather
  // than reading as fully role-less.
  it('a course naming only one role shows just that role, not the other as empty', async () => {
    const adminsOnly: CourseSummary = { ...COURSE, studentsRole: null }
    listCourses.mockResolvedValue([adminsOnly])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(screen.getByText('admins-wd-fa26')).toBeInTheDocument()
    expect(
      screen.queryByText(/does not route on a role/)
    ).not.toBeInTheDocument()
    // Singular — only one role is actually present. `(?!s)` rules out
    // matching the "roles" substring inside a plural reading.
    expect(screen.getByText(/routes on role(?!s)/)).toBeInTheDocument()
  })

  // The control on the case above: a course naming *both* roles reads
  // "routes on roles" (plural), not the singular wording a course naming
  // only one gets. Fails without the fix: this line read "routes on role
  // X / Y" even with both present — WEB-46 only changed the three
  // checkbox descriptions, never this one.
  it('a course naming both roles reads "routes on roles" (plural), not "routes on role"', async () => {
    listCourses.mockResolvedValue([COURSE])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(screen.getByText(/routes on roles/)).toBeInTheDocument()
  })

  // WEB-45: the list/collection shape — a row-shaped skeleton, gone once
  // the real course rows take its place.
  it('shows row-shaped skeletons while loading, announces them to assistive technology, and swaps them for the real list once courses.list resolves', async () => {
    let resolveCourses: ((courses: CourseSummary[]) => void) | undefined
    listCourses.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCourses = resolve
        })
    )

    const { container } = renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(
      0
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(screen.queryByText('Web Design')).not.toBeInTheDocument()

    resolveCourses?.([COURSE])

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0)
  })

  // WEB-45 (Admin.tsx-style regression): a refused courses.list must not
  // also show a skeleton claiming this is still loading — the same
  // `!error` guard `Admin.tsx`'s own `failed` check already holds every
  // one of its own three screens to.
  it('a failed load renders only the failure, never a skeleton pulsing underneath it', async () => {
    listCourses.mockRejectedValue(
      new ApiError(403, { error: 'action_refused' })
    )

    const { container } = renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0)
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
        onProjectChanged={vi.fn()}
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
        onProjectChanged={vi.fn()}
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
        onProjectChanged={vi.fn()}
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
        onProjectChanged={vi.fn()}
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
          onProjectChanged={vi.fn()}
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
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'New course' }))
    expect(onOpenCourse).toHaveBeenCalledWith(undefined)

    fireEvent.click(screen.getByRole('button', { name: 'Web Design' }))
    expect(onOpenCourse).toHaveBeenCalledWith('course-1')
  })

  // WEB-42 review finding: a successful row action's own `refresh()` — this
  // screen's own fetch, not `CourseRows`' own row-action errors — could
  // fail transiently and leave `error` set with nothing left to clear it,
  // once the toggle/export handlers (and their own `setError(undefined)`)
  // moved into `CourseRows`. Fails without `refresh`'s own `setError(undefined)`:
  // the banner from the first, failed refresh would still be on screen
  // after the second action's refresh succeeds.
  it("a failed refresh's error banner clears once a later action's own refresh succeeds", async () => {
    listCourses
      .mockResolvedValueOnce([COURSE])
      .mockRejectedValueOnce(new ApiError(500, { error: 'internal_error' }))
      .mockResolvedValueOnce([COURSE])
    disableCourse.mockResolvedValue({ disabled: true })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    // First action: succeeds, but the refresh after it fails.
    openCourseMenu('Web Design')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Web Design"' })
      ).getByRole('button', { name: 'Disable' })
    )
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Disable',
      })
    )
    await waitFor(() => expect(disableCourse).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    // Second action: the row still reads "enabled" (the failed refresh
    // above never updated it), so the same menu item is clicked again —
    // this time its own refresh succeeds.
    openCourseMenu('Web Design')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Web Design"' })
      ).getByRole('button', { name: 'Disable' })
    )
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Disable',
      })
    )
    await waitFor(() => expect(disableCourse).toHaveBeenCalledTimes(2))

    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    )
  })
})

/**
 * WEB-39/PORT-1: a course row's own Export item — the action returns the
 * file's text (PORT-8: an export is an action, not a download route), and
 * this screen is what hands it to the browser to save.
 */
describe('Courses — export (WEB-39)', () => {
  it("exports the row's course and saves the file the action named", async () => {
    listCourses.mockResolvedValue([COURSE])
    exportCourse.mockResolvedValue({
      filename: 'web-design.course.yml',
      content: 'bloombotCourseExport: 1\n',
      notCarried: {
        vectorStore: false,
        storedPrompt: false,
        attachments: 0,
        discordServer: false,
      },
    })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    openCourseMenu('Web Design')
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() =>
      expect(exportCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
    await waitFor(() =>
      expect(downloadTextFile).toHaveBeenCalledWith(
        'web-design.course.yml',
        'bloombotCourseExport: 1\n'
      )
    )
  })
})

/**
 * PROJ-8/WEB-50: a course row's own Delete item — last in its kebab, a
 * preview read into the confirmation, and a typed-name prompt before the
 * destructive call ever runs, the same shape `admin.test.tsx`'s own
 * ADMIN-5 tests already pin for a tenant.
 */
describe('Courses — delete (PROJ-8/WEB-50)', () => {
  const PREVIEW = {
    organizationId: 'org-1',
    courseId: 'course-1',
    courseTitle: 'Web Design',
    conversations: 3,
    messages: 12,
    enrolments: 2,
    courseAttachments: 1,
  }

  it('offers Delete, last, in the row’s kebab', async () => {
    listCourses.mockResolvedValue([COURSE])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    openCourseMenu('Web Design')
    const menu = screen.getByRole('group', { name: 'Actions for "Web Design"' })
    const items = within(menu).getAllByRole('button')
    expect(items.at(-1)).toHaveTextContent('Delete')
  })

  it('previews what will be deleted, then requires the course’s own title typed exactly', async () => {
    listCourses.mockResolvedValue([COURSE])
    previewDeleteCourse.mockResolvedValue(PREVIEW)

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    openCourseMenu('Web Design')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Web Design"' })
      ).getByRole('button', { name: 'Delete' })
    )

    // PROJ-8: "names exactly what will be deleted before it happens" — the
    // preview's own counts are read into the confirmation itself.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('3 conversation(s)')
    expect(dialog).toHaveTextContent('12 message(s)')
    expect(dialog).toHaveTextContent('2 enrolment(s)')
    expect(dialog).toHaveTextContent('1 knowledge file(s)')

    // Cancelling deletes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deleteCourse).not.toHaveBeenCalled()
  })

  it('typing the wrong title keeps the dialog open and never calls through; the exact title proceeds and the row disappears', async () => {
    listCourses.mockResolvedValueOnce([COURSE]).mockResolvedValueOnce([])
    previewDeleteCourse.mockResolvedValue(PREVIEW)

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    openCourseMenu('Web Design')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Web Design"' })
      ).getByRole('button', { name: 'Delete' })
    )
    const dialog = await screen.findByRole('dialog')

    const field = within(dialog).getByLabelText('Course title')
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Delete',
    })
    // WEB-50 rework finding: disabled until the title typed matches
    // exactly — not merely checked after a click.
    expect(confirmButton).toBeDisabled()
    fireEvent.change(field, { target: { value: 'the wrong title' } })
    expect(confirmButton).toBeDisabled()
    expect(deleteCourse).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: 'Web Design' } })
    expect(confirmButton).not.toBeDisabled()
    deleteCourse.mockResolvedValue(PREVIEW)
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(deleteCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
    // The list refetches on success — the row is gone.
    await waitFor(() =>
      expect(screen.queryByText('Web Design')).not.toBeInTheDocument()
    )
  })

  it('a failed delete is reported and the row stays', async () => {
    listCourses.mockResolvedValue([COURSE])
    previewDeleteCourse.mockResolvedValue(PREVIEW)
    deleteCourse.mockRejectedValue(
      new ApiError(403, { error: 'not_authorized' })
    )

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    openCourseMenu('Web Design')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Web Design"' })
      ).getByRole('button', { name: 'Delete' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Course title'), {
      target: { value: 'Web Design' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(await screen.findByText('Web Design')).toBeInTheDocument()
  })
})

/**
 * WEB-61: the project's own screen (this component, at
 * `/o/:organizationId/projects/:projectId`) now carries the same kebab menu
 * `pages/Projects.tsx`'s own row shows for this project — Archive/Restore,
 * Duplicate, Import, Rename, Delete, through the shared
 * `hooks/useProjectMenu.tsx` — proving each item is reachable and dispatches
 * the same action `tests/projects.test.tsx` already pins for the row.
 */
describe('Courses — the project screen carries the same menu its row does (WEB-61)', () => {
  it('sits in the row holding "New course," immediately to its left', async () => {
    listCourses.mockResolvedValue([])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('No courses in this project yet.')

    const kebab = screen.getByRole('button', {
      name: 'Actions for "Fall 2026"',
    })
    const newCourse = screen.getByRole('button', { name: 'New course' })
    // `compareDocumentPosition` — DOCUMENT_POSITION_FOLLOWING (4) means
    // `newCourse` comes *after* `kebab` in the DOM, i.e. the kebab is to
    // its left.
    expect(
      kebab.compareDocumentPosition(newCourse) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('offers every item the row does — Archive/Restore, Duplicate, Import, Rename, Delete, in that order', async () => {
    listCourses.mockResolvedValue([])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('No courses in this project yet.')

    openProjectMenu('Fall 2026')
    const menu = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    const items = within(menu).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual([
      'Archive',
      'Duplicate',
      'Import',
      'Rename',
      'Delete',
    ])
  })

  it('archives the project through the same non-destructive confirmation the row uses, and reports the archived project back', async () => {
    listCourses.mockResolvedValue([])
    archiveProject.mockResolvedValue({ archived: true })
    const onProjectChanged = vi.fn()

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={onProjectChanged}
      />
    )
    await screen.findByText('No courses in this project yet.')

    openProjectMenu('Fall 2026')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
      ).getByRole('button', { name: 'Archive' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Archive Fall 2026?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))

    await waitFor(() =>
      expect(archiveProject).toHaveBeenCalledWith('org-1', 'project-1')
    )
    // `projects.archive` returns only `{ archived: boolean }`
    // (`hooks/useProjectMenu.tsx`'s own doc comment on why) — this screen's
    // own heading has no archived badge of its own to check, so this pins
    // the one thing observable from here: the caller is told, so its own
    // "Restore" label (once it re-renders `Courses` with the updated
    // project) is not still offering "Archive" for a project that already
    // is.
    await waitFor(() =>
      expect(onProjectChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'project-1',
          archivedAt: expect.any(Number),
        })
      )
    )
  })

  it('renames the project through the same prompt modal the row uses, and reports the renamed project back (this screen does not own the record its own heading names)', async () => {
    listCourses.mockResolvedValue([])
    const renamed = { ...PROJECT, name: 'Autumn 2026' }
    renameProject.mockResolvedValue(renamed)
    const onProjectChanged = vi.fn()

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={onProjectChanged}
      />
    )
    await screen.findByText('No courses in this project yet.')

    openProjectMenu('Fall 2026')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
      ).getByRole('button', { name: 'Rename' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Rename "Fall 2026"',
    })
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: 'Autumn 2026' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))

    await waitFor(() =>
      expect(renameProject).toHaveBeenCalledWith(
        'org-1',
        'project-1',
        'Autumn 2026'
      )
    )
    // WEB-61 — `pages/ProjectsPanel.tsx` is what actually holds `project`;
    // this is the cue it updates in place. Fails without it: the caller
    // (here, the real `ProjectsPanel`) would keep passing the *old*
    // `project`, and this screen's own heading — `project.name` — would
    // still read "Fall 2026" after a successful rename.
    await waitFor(() => expect(onProjectChanged).toHaveBeenCalledWith(renamed))
  })

  it('duplicates the project through the same prompt modal, reporting the same disabled-courses notice', async () => {
    listCourses.mockResolvedValue([])
    duplicateProject.mockResolvedValue({
      project: { ...PROJECT, id: 'project-2', name: 'Spring 2027' },
      coursesCopied: 1,
      coursesDisabled: true,
    })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('No courses in this project yet.')

    openProjectMenu('Fall 2026')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
      ).getByRole('button', { name: 'Duplicate' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Duplicate "Fall 2026"',
    })
    fireEvent.change(within(dialog).getByLabelText('New project name'), {
      target: { value: 'Spring 2027' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate' }))

    await waitFor(() =>
      expect(duplicateProject).toHaveBeenCalledWith(
        'org-1',
        'project-1',
        'Spring 2027'
      )
    )
    expect(await screen.findByTestId('duplicate-notice')).toHaveTextContent(
      'Spring 2027'
    )
  })

  it('opens the import dialog for this project', async () => {
    listCourses.mockResolvedValue([])

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('No courses in this project yet.')

    openProjectMenu('Fall 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(
      screen.getByText('Import a course into "Fall 2026"')
    ).toBeInTheDocument()
  })

  it('Delete previews and confirms by typing the project’s own name, the same as the row does, before deleteProject is ever called', async () => {
    listCourses.mockResolvedValue([])
    previewDeleteProject.mockResolvedValue({
      organizationId: 'org-1',
      projectId: 'project-1',
      projectName: 'Fall 2026',
      courses: 2,
      conversations: 3,
      messages: 12,
      enrolments: 2,
      courseAttachments: 1,
    })

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('No courses in this project yet.')

    openProjectMenu('Fall 2026')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
      ).getByRole('button', { name: 'Delete' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('2 course(s)')

    // Typing the wrong name never calls through.
    const field = within(dialog).getByLabelText('Project name')
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Delete',
    })
    expect(confirmButton).toBeDisabled()
    fireEvent.change(field, { target: { value: 'the wrong name' } })
    expect(confirmButton).toBeDisabled()
    expect(deleteProject).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: 'Fall 2026' } })
    expect(confirmButton).not.toBeDisabled()
  })

  // WEB-61 — deleting the project this screen names leaves nothing here to
  // show, so it must navigate away rather than merely refresh (the fate
  // every other project mutation gets). `onBack` is the same "go somewhere
  // that still exists" control the `← Projects` button already is.
  it('after Delete succeeds, navigates back to the project list rather than staying on a project that no longer exists', async () => {
    listCourses.mockResolvedValue([])
    previewDeleteProject.mockResolvedValue({
      organizationId: 'org-1',
      projectId: 'project-1',
      projectName: 'Fall 2026',
      courses: 0,
      conversations: 0,
      messages: 0,
      enrolments: 0,
      courseAttachments: 0,
    })
    deleteProject.mockResolvedValue({
      organizationId: 'org-1',
      projectId: 'project-1',
      projectName: 'Fall 2026',
      courses: 0,
      conversations: 0,
      messages: 0,
      enrolments: 0,
      courseAttachments: 0,
    })
    const onBack = vi.fn()

    renderWithModal(
      <Courses
        organizationId="org-1"
        project={PROJECT}
        onBack={onBack}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
        onProjectChanged={vi.fn()}
      />
    )
    await screen.findByText('No courses in this project yet.')

    openProjectMenu('Fall 2026')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
      ).getByRole('button', { name: 'Delete' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: 'Fall 2026' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(deleteProject).toHaveBeenCalledWith('org-1', 'project-1')
    )
    await waitFor(() => expect(onBack).toHaveBeenCalled())
  })
})
