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

  it('archives an active project and restores an archived one', async () => {
    listProjects.mockResolvedValue([PROJECT])
    archiveProject.mockResolvedValue({ archived: true })

    render(<Projects organizationId="org-1" onOpenProject={vi.fn()} />)
    await screen.findByText('Fall 2026')

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await waitFor(() =>
      expect(archiveProject).toHaveBeenCalledWith('org-1', 'project-1')
    )
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
