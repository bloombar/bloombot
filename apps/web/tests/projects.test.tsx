/**
 * `pages/Projects.tsx` (WEB-7): list, create, archive/restore, duplicate —
 * each dispatched through the exact action `@bloombot/actions` exposes,
 * mocked here the same way `tests/shell.test.tsx` mocks `api/client.ts`.
 * The duplicate-disabled message (PROJ-4/D-23) gets its own test: without
 * it, an instructor who duplicates a project has to discover for themselves
 * why nothing is routing — exactly what WEB-7's own text says this screen
 * must not leave them to do.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { Project } from '../src/api/types.js'
import { Projects } from '../src/pages/Projects.js'

const {
  listProjects,
  createProject,
  archiveProject,
  unarchiveProject,
  duplicateProject,
} = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  duplicateProject: vi.fn(),
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
    duplicateProject,
  }
})

const PROJECT: Project = {
  id: 'project-1',
  organizationId: 'org-1',
  name: 'Fall 2026',
  archivedAt: null,
  createdAt: 0,
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('Projects (WEB-7)', () => {
  it("lists the organization's active projects, excluding archived by default", async () => {
    listProjects.mockResolvedValue([PROJECT])

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)

    expect(await screen.findByText('Fall 2026')).toBeInTheDocument()
    expect(listProjects).toHaveBeenCalledWith('org-1', false)
  })

  it('toggling "show archived" re-lists with includeArchived: true', async () => {
    listProjects.mockResolvedValue([PROJECT])

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
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

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
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

  it('creates a project and refreshes the list', async () => {
    listProjects.mockResolvedValue([])
    createProject.mockResolvedValue(PROJECT)

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('No projects yet.')

    fireEvent.change(screen.getByLabelText('New project name'), {
      target: { value: 'Fall 2026' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

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

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('No projects yet.')

    fireEvent.change(screen.getByLabelText('New project name'), {
      target: { value: '  Fall 2026  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith('org-1', 'Fall 2026')
    )
  })

  it('a whitespace-only duplicate name is rejected the same way Create rejects one (finding 7 of the WEB-7 rework)', async () => {
    listProjects.mockResolvedValue([PROJECT])

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('Fall 2026')

    fireEvent.change(screen.getByLabelText('Duplicate "Fall 2026" as'), {
      target: { value: '   ' },
    })

    // Consistent with Create's own `.trim()` guard, not the raw truthiness
    // that used to accept this and create an effectively unopenable
    // project.
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(duplicateProject).not.toHaveBeenCalled()
  })

  it('archives an active project', async () => {
    listProjects.mockResolvedValue([PROJECT])
    archiveProject.mockResolvedValue({ archived: true })

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('Fall 2026')

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await waitFor(() =>
      expect(archiveProject).toHaveBeenCalledWith('org-1', 'project-1')
    )
    expect(unarchiveProject).not.toHaveBeenCalled()
  })

  it('restores an archived project — the branch the previous test never actually clicked (finding 6 of the WEB-7 rework)', async () => {
    const archivedProject: Project = { ...PROJECT, archivedAt: 1_700_000_000 }
    listProjects.mockResolvedValue([archivedProject])
    unarchiveProject.mockResolvedValue({ archived: false })

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('Fall 2026')

    // The archived marker, and the button's label for an archived project —
    // both distinct from the active-project case above.
    expect(screen.getByText(/\(archived\)/)).toBeInTheDocument()
    const restoreButton = screen.getByRole('button', { name: 'Restore' })

    fireEvent.click(restoreButton)

    await waitFor(() =>
      expect(unarchiveProject).toHaveBeenCalledWith('org-1', 'project-1')
    )
    // Without this, a `handleArchive` that called `archiveProject` in both
    // branches would leave this whole suite green while Restore silently
    // re-archived an already-archived project.
    expect(archiveProject).not.toHaveBeenCalled()
  })

  it('a duplicate reports plainly that every copied course arrived disabled, and why (PROJ-4/D-23)', async () => {
    listProjects.mockResolvedValue([PROJECT])
    duplicateProject.mockResolvedValue({
      project: { ...PROJECT, id: 'project-2', name: 'Spring 2027' },
      coursesCopied: 3,
      coursesDisabled: true,
    })

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('Fall 2026')

    fireEvent.change(screen.getByLabelText('Duplicate "Fall 2026" as'), {
      target: { value: 'Spring 2027' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

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

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('No projects yet.')

    fireEvent.change(screen.getByLabelText('New project name'), {
      target: { value: 'Fall 2026' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project name "Fall 2026" is already used by another active project in this organization.'
    )
  })

  it('opening a project hands it up to the caller', async () => {
    listProjects.mockResolvedValue([PROJECT])
    const onOpenProject = vi.fn()

    render(<Projects organizationId="org-1" onOpenProject={onOpenProject} />)
    await screen.findByText('Fall 2026')

    fireEvent.click(screen.getByRole('button', { name: 'Fall 2026' }))

    expect(onOpenProject).toHaveBeenCalledWith(PROJECT)
  })
})
