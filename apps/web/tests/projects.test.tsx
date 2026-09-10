/**
 * `pages/Projects.tsx` (WEB-7): list, create, archive/restore, rename and
 * duplicate — each dispatched through the exact action `@bloombot/actions`
 * exposes, mocked here the same way `tests/shell.test.tsx` mocks
 * `api/client.ts`. WEB-26/WEB-27: create, rename and duplicate all go
 * through the one prompt modal (`components/modal/`) now, and Archive/
 * Restore/Duplicate/Rename live behind each row's own kebab menu
 * (`components/KebabMenu.tsx`). The duplicate-disabled message (PROJ-4/D-23)
 * gets its own test: without it, an instructor who duplicates a project has
 * to discover for themselves why nothing is routing — exactly what WEB-7's
 * own text says this screen must not leave them to do.
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseSummary, Project } from '../src/api/types.js'
import { Projects } from '../src/pages/Projects.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  listProjects,
  createProject,
  archiveProject,
  unarchiveProject,
  renameProject,
  duplicateProject,
  listCourses,
  disableCourse,
  enableCourse,
  exportCourse,
  downloadTextFile,
} = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  renameProject: vi.fn(),
  duplicateProject: vi.fn(),
  // WEB-42 — `Projects` now fetches each listed project's own courses, and
  // its shared `CourseRows` row offers the same Export/Disable-Enable
  // `pages/Courses.tsx` does — every test in this file needs all four of
  // these mocked too, not only the ones that assert on them below; a real
  // implementation would otherwise dispatch an actual, unmocked action
  // from under every one of them.
  listCourses: vi.fn(),
  disableCourse: vi.fn(),
  enableCourse: vi.fn(),
  exportCourse: vi.fn(),
  downloadTextFile: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listProjects,
    createProject,
    archiveProject,
    unarchiveProject,
    renameProject,
    duplicateProject,
    listCourses,
    disableCourse,
    enableCourse,
    exportCourse,
    downloadTextFile,
  }
})

const PROJECT: Project = {
  id: 'project-1',
  organizationId: 'org-1',
  name: 'Fall 2026',
  archivedAt: null,
  createdAt: 0,
}

/** Opens a project row's own kebab menu, by its own `aria-label` (WEB-26) — every menu item test below goes through this rather than reaching the item directly, so it also proves the item is actually reachable behind the row's own control, not merely present on the page. */
function openProjectMenu(projectName: string) {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for "${projectName}"` })
  )
}

beforeEach(() => {
  // Default: no courses under any project — the tests below that care
  // about the courses listing override this per case; the rest just need
  // it to resolve at all.
  listCourses.mockResolvedValue([])
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('Projects (WEB-7)', () => {
  it("lists the organization's active projects, excluding archived by default", async () => {
    listProjects.mockResolvedValue([PROJECT])

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )

    expect(await screen.findByText('Fall 2026')).toBeInTheDocument()
    expect(listProjects).toHaveBeenCalledWith('org-1', false)
  })

  it('toggling "show archived" re-lists with includeArchived: true', async () => {
    listProjects.mockResolvedValue([PROJECT])

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    fireEvent.click(screen.getByLabelText('Show archived'))

    await waitFor(() =>
      expect(listProjects).toHaveBeenCalledWith('org-1', true)
    )
  })

  it('a stale, out-of-order response cannot leave the list disagreeing with "Show archived" (finding 8 of the WEB-7 rework)', async () => {
    let resolveInitial: (value: Project[]) => void = () => {}
    let resolveArchived: (value: Project[]) => void = () => {}
    listProjects
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveArchived = resolve
          })
      )

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    fireEvent.click(screen.getByLabelText('Show archived'))

    // The later request (includeArchived: true) resolves first, and the
    // superseded initial request resolves after it — exactly the
    // out-of-order case `refreshId` exists to guard against.
    const archivedProject: Project = {
      ...PROJECT,
      id: 'project-2',
      name: 'Old Term',
      archivedAt: 1_700_000_000,
    }
    resolveArchived([archivedProject])
    await screen.findByText('Old Term')
    resolveInitial([PROJECT])
    // Flush the microtask queue so the stale response's `.then` — the one
    // that must be ignored — has a chance to run before this asserts.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('Old Term')).toBeInTheDocument()
    expect(screen.queryByText('Fall 2026')).not.toBeInTheDocument()
  })

  // WEB-27: "New project" opens a modal that asks for the name, rather than
  // an always-present inline input and its own Create button.
  it('creates a project through the "New project" modal and refreshes the list', async () => {
    listProjects.mockResolvedValue([])
    createProject.mockResolvedValue(PROJECT)

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('No projects yet.')

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: 'Fall 2026' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith('org-1', 'Fall 2026')
    )
    // The refresh after create is the same `listProjects` call the initial
    // mount made — called a second time, not replaced by anything this
    // component invents on its own.
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2))
  })

  it('trims a name with surrounding whitespace before creating (finding 7 of the WEB-7 rework)', async () => {
    listProjects.mockResolvedValue([])
    createProject.mockResolvedValue(PROJECT)

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('No projects yet.')

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: '  Fall 2026  ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith('org-1', 'Fall 2026')
    )
  })

  // Carries forward finding 7 of the WEB-7 rework (a whitespace-only name is
  // rejected the same way everywhere) into the modal `prompt()` now handles
  // every project name: the dialog stays open, naming the problem, rather
  // than silently accepting it.
  it('a whitespace-only name is refused by the "New project" modal, not silently accepted', async () => {
    listProjects.mockResolvedValue([])

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('No projects yet.')

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: '   ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(
      within(dialog).getByText('Enter a project name.')
    ).toBeInTheDocument()
    expect(createProject).not.toHaveBeenCalled()
  })

  it('archives an active project from its kebab menu, behind a (non-destructive) confirmation — WEB-15: archiving stops every course in it routing, more consequence than disabling one', async () => {
    listProjects.mockResolvedValue([PROJECT])
    archiveProject.mockResolvedValue({ archived: true })

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    openProjectMenu('Fall 2026')
    const menu = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Archive' }))
    // Not yet — confirms first.
    expect(archiveProject).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', {
      name: 'Archive Fall 2026?',
    })
    // Non-destructive: the confirm button reads plainly, not the danger
    // styling `variant="destructive"` renders — archiving must never look
    // like deleting (PROJ-2, WEB-15).
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Archive',
    })
    expect(confirmButton.className).not.toContain('danger')
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(archiveProject).toHaveBeenCalledWith('org-1', 'project-1')
    )
    expect(unarchiveProject).not.toHaveBeenCalled()
  })

  it('restores an archived project from its kebab menu — the branch the previous test never actually clicked (finding 6 of the WEB-7 rework)', async () => {
    const archivedProject: Project = { ...PROJECT, archivedAt: 1_700_000_000 }
    listProjects.mockResolvedValue([archivedProject])
    unarchiveProject.mockResolvedValue({ archived: false })

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    // The archived marker, and the item's own label for an archived
    // project — both distinct from the active-project case above.
    expect(screen.getByText(/\(archived\)/)).toBeInTheDocument()
    openProjectMenu('Fall 2026')
    const menu = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Restore' }))

    await waitFor(() =>
      expect(unarchiveProject).toHaveBeenCalledWith('org-1', 'project-1')
    )
    // Without this, a `handleArchive` that called `archiveProject` in both
    // branches would leave this whole suite green while Restore silently
    // re-archived an already-archived project.
    expect(archiveProject).not.toHaveBeenCalled()
  })

  // PROJ-6/WEB-26: rename, over the `projects.rename` action.
  it('renames a project through its kebab menu and the prompt modal', async () => {
    listProjects.mockResolvedValue([PROJECT])
    renameProject.mockResolvedValue({ ...PROJECT, name: 'Autumn 2026' })

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    openProjectMenu('Fall 2026')
    const menu = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Rename "Fall 2026"',
    })
    // Pre-filled with the project's own current name.
    expect(within(dialog).getByLabelText('Project name')).toHaveValue(
      'Fall 2026'
    )
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
  })

  // WEB-5/PROJ-1: the refusal names the colliding project's own message,
  // not a generic failure — the same treatment `create`'s own collision
  // test below already pins.
  it("a rename refused for a name collision renders the conflict's own message, naming the colliding project", async () => {
    listProjects.mockResolvedValue([PROJECT])
    renameProject.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: {
          message:
            'Project name "Spring 2027" is already used by another active project in this organization.',
        },
      })
    )

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    openProjectMenu('Fall 2026')
    const menu = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Rename "Fall 2026"',
    })
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: 'Spring 2027' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project name "Spring 2027" is already used by another active project in this organization.'
    )
  })

  it('duplicates a project through its kebab menu and the prompt modal, reporting plainly that every copied course arrived disabled, and why (PROJ-4/D-23)', async () => {
    listProjects.mockResolvedValue([PROJECT])
    duplicateProject.mockResolvedValue({
      project: { ...PROJECT, id: 'project-2', name: 'Spring 2027' },
      coursesCopied: 3,
      coursesDisabled: true,
    })

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    openProjectMenu('Fall 2026')
    const menu = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Duplicate' }))
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
    const notice = await screen.findByTestId('duplicate-notice')
    expect(notice).toHaveTextContent('3 courses')
    expect(notice).toHaveTextContent('disabled')
    expect(notice).toHaveTextContent('Spring 2027')
  })

  it("a create refused for a name collision renders the conflict's own message (WEB-5)", async () => {
    listProjects.mockResolvedValue([])
    createProject.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: {
          message:
            'Project name "Fall 2026" is already used by another active project in this organization.',
        },
      })
    )

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('No projects yet.')

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    fireEvent.change(within(dialog).getByLabelText('Project name'), {
      target: { value: 'Fall 2026' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project name "Fall 2026" is already used by another active project in this organization.'
    )
  })

  it('opening a project hands it up to the caller', async () => {
    listProjects.mockResolvedValue([PROJECT])
    const onOpenProject = vi.fn()

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={onOpenProject}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    fireEvent.click(screen.getByRole('button', { name: 'Fall 2026' }))

    expect(onOpenProject).toHaveBeenCalledWith(PROJECT)
  })
})

/**
 * WEB-39/PORT-4: the project row's own Import item opens the course import
 * dialog for *that* project, and a successful import is said out loud on
 * this screen rather than only inside the dialog that closed.
 */
describe('Projects — import a course (WEB-39)', () => {
  it('opens the import dialog for the row it was chosen from', async () => {
    listProjects.mockResolvedValue([PROJECT])

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    openProjectMenu('Fall 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(
      screen.getByText('Import a course into "Fall 2026"')
    ).toBeInTheDocument()
    // PORT-6, said before the import runs rather than after it.
    expect(screen.getByText(/arrives disabled/)).toBeInTheDocument()
  })

  it('shows no import dialog until the item is chosen', async () => {
    listProjects.mockResolvedValue([PROJECT])

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    expect(
      screen.queryByText('Import a course into "Fall 2026"')
    ).not.toBeInTheDocument()
  })
})

/**
 * WEB-42: each project row also lists that project's own courses, beneath
 * it, with the same controls `pages/Courses.tsx` offers — sharing
 * `components/CourseRows.tsx` rather than a second implementation of
 * Export/Disable-Enable grown here. `courses.list` takes one project at a
 * time, so this screen issues one request per listed project, in parallel.
 */
describe('Projects — courses beneath each project (WEB-42)', () => {
  const PROJECT_TWO: Project = {
    id: 'project-2',
    organizationId: 'org-1',
    name: 'Spring 2027',
    archivedAt: null,
    createdAt: 0,
  }

  const COURSE_ONE: CourseSummary = {
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
  }

  const COURSE_TWO: CourseSummary = {
    ...COURSE_ONE,
    id: 'course-2',
    projectId: 'project-2',
    title: 'Data Structures',
  }

  /** Every `Chat` control on the page is named after its own course (WEB-28), so this reaches the row scoped to one project rather than by button text alone — the same reason `courses.test.tsx#openCourseMenu` scopes by row. */
  function courseRow(courseId: string) {
    return screen.getByTestId(`course-${courseId}`)
  }

  it("lists each project's own courses beneath it, under the correct project", async () => {
    listProjects.mockResolvedValue([PROJECT, PROJECT_TWO])
    listCourses.mockImplementation(
      (_organizationId: string, projectId: string) =>
        Promise.resolve(projectId === 'project-1' ? [COURSE_ONE] : [COURSE_TWO])
    )

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )

    expect(await screen.findByText('Web Design')).toBeInTheDocument()
    expect(await screen.findByText('Data Structures')).toBeInTheDocument()
    expect(listCourses).toHaveBeenCalledWith('org-1', 'project-1')
    expect(listCourses).toHaveBeenCalledWith('org-1', 'project-2')

    // The assertion out-of-order resolution would fail: each course
    // nested under its *own* project's `<li>`, not merely present
    // somewhere on the page.
    expect(
      within(courseRow('course-1')).getByText('Web Design')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('project-project-1')).getByText('Web Design')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('project-project-2')).getByText(
        'Data Structures'
      )
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('project-project-1')).queryByText(
        'Data Structures'
      )
    ).not.toBeInTheDocument()
  })

  it('a course appears under the right project even when the slower project resolves first', async () => {
    listProjects.mockResolvedValue([PROJECT, PROJECT_TWO])
    let resolveProjectOne: (value: CourseSummary[]) => void = () => {}
    listCourses.mockImplementation(
      (_organizationId: string, projectId: string) => {
        if (projectId === 'project-1') {
          return new Promise((resolve) => {
            resolveProjectOne = resolve
          })
        }
        return Promise.resolve([COURSE_TWO])
      }
    )

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )

    // project-2's own courses resolve well before project-1's.
    expect(await screen.findByText('Data Structures')).toBeInTheDocument()
    resolveProjectOne([COURSE_ONE])
    expect(await screen.findByText('Web Design')).toBeInTheDocument()

    expect(
      within(screen.getByTestId('project-project-1')).getByText('Web Design')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('project-project-2')).getByText(
        'Data Structures'
      )
    ).toBeInTheDocument()
  })

  it('a project with no courses renders the empty state Courses.tsx already uses', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([])

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Fall 2026')

    expect(
      await screen.findByText('No courses in this project yet.')
    ).toBeInTheDocument()
  })

  it("one project's failed courses fetch renders that failure without blanking the other project's own courses", async () => {
    listProjects.mockResolvedValue([PROJECT, PROJECT_TWO])
    listCourses.mockImplementation(
      (_organizationId: string, projectId: string) =>
        projectId === 'project-1'
          ? Promise.reject(new ApiError(500, { error: 'internal_error' }))
          : Promise.resolve([COURSE_TWO])
    )

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )

    expect(await screen.findByText('Data Structures')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('project-project-1')).getByRole('alert')
    ).toBeInTheDocument()
  })

  it('the courses beneath a project are real nested markup — a list inside the project item, not merely indented text', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE_ONE])

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    const projectItem = screen.getByTestId('project-project-1')
    // The project item is itself a listitem (its own `<ul>` in `Projects`);
    // the courses beneath it are a *second*, nested list — not merely a
    // padded `<div>` of course text.
    expect(projectItem.tagName).toBe('LI')
    const nestedList = within(projectItem).getByRole('list')
    expect(within(nestedList).getByRole('listitem')).toContainElement(
      courseRow('course-1')
    )
  })

  it('a course title opens the course editor for the right project', async () => {
    listProjects.mockResolvedValue([PROJECT, PROJECT_TWO])
    listCourses.mockImplementation(
      (_organizationId: string, projectId: string) =>
        Promise.resolve(projectId === 'project-1' ? [COURSE_ONE] : [COURSE_TWO])
    )
    const onOpenCourse = vi.fn()

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={onOpenCourse}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Data Structures')

    fireEvent.click(screen.getByRole('button', { name: 'Data Structures' }))

    expect(onOpenCourse).toHaveBeenCalledWith(PROJECT_TWO, 'course-2')
  })

  it('Chat on a course row beneath a project hands its id up to onOpenChat', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE_ONE])
    const onOpenChat = vi.fn()

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
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

  it('disables a course from its kebab menu beneath a project, through the same confirmation, and refreshes only that project', async () => {
    listProjects.mockResolvedValue([PROJECT, PROJECT_TWO])
    listCourses.mockImplementation(
      (_organizationId: string, projectId: string) =>
        Promise.resolve(projectId === 'project-1' ? [COURSE_ONE] : [COURSE_TWO])
    )
    disableCourse.mockResolvedValue({ disabled: true })

    renderWithModal(
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Web Design')
    await screen.findByText('Data Structures')
    listCourses.mockClear()

    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for "Web Design"' })
    )
    const menu = screen.getByRole('group', { name: 'Actions for "Web Design"' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Disable' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable' }))

    await waitFor(() =>
      expect(disableCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
    // Only the affected project's own courses refresh — not project-2's.
    await waitFor(() =>
      expect(listCourses).toHaveBeenCalledWith('org-1', 'project-1')
    )
    expect(listCourses).not.toHaveBeenCalledWith('org-1', 'project-2')
  })

  it('exports a course from its kebab menu beneath a project, and hands the file to the browser', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE_ONE])
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
      <Projects
        organizationId="org-1"
        onOpenProject={vi.fn()}
        onOpenCourse={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )
    await screen.findByText('Web Design')

    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for "Web Design"' })
    )
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
