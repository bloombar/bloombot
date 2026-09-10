/**
 * WEB-32/WEB-34: `pages/ProjectsPanel.tsx`'s own routing wiring — which
 * address each of the four project/course screens navigates to, and with a
 * push or a replace. Both cases here are review findings against the slice
 * that introduced the router, and both are about history rather than about
 * anything either screen renders.
 *
 * `CourseEditor` is stubbed: this file is about what `ProjectsPanel` does
 * with the callbacks it hands down, not about the editor's own form (which
 * `tests/course-editor.test.tsx` covers in full). The stub is what makes
 * "saved twice" a single, deterministic click each time.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderWithModal, withModal } from './helpers/render-with-modal.js'
import { ProjectsPanel } from '../src/pages/ProjectsPanel.js'
import type { Project } from '../src/api/types.js'

const { listProjects, listCourses } = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listCourses: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, listProjects, listCourses }
})

vi.mock('../src/pages/CourseEditor.js', () => ({
  CourseEditor: ({
    onSaved,
  }: {
    onSaved: (course: { id: string }) => void
  }) => (
    <button type="button" onClick={() => onSaved({ id: 'course-1' })}>
      save
    </button>
  ),
}))

const PROJECT_ONE: Project = {
  id: 'project-1',
  name: 'Autumn term',
  archivedAt: null,
} as Project

const PROJECT_TWO: Project = {
  id: 'project-2',
  name: 'Spring term',
  archivedAt: null,
} as Project

beforeEach(() => {
  listProjects.mockResolvedValue([PROJECT_ONE, PROJECT_TWO])
  listCourses.mockResolvedValue([])
})

afterEach(() => {
  vi.resetAllMocks()
})

describe('ProjectsPanel (WEB-32, WEB-34)', () => {
  it('replaces rather than pushes when a course is saved, so repeated saves do not stack history entries', async () => {
    const navigate = vi.fn()

    renderWithModal(
      <ProjectsPanel
        organizationId="org-1"
        route={{
          kind: 'new-course',
          organizationId: 'org-1',
          projectId: 'project-1',
        }}
        navigate={navigate}
        onOpenChat={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'save' }))
    fireEvent.click(screen.getByRole('button', { name: 'save' }))

    // Fails without the fix: `onSaved` pushed, so two saves left two
    // identical entries on top of the blank `new-course` form — Back landed
    // on an empty creation screen for a course that already existed, where
    // saving again would create a duplicate.
    expect(navigate).toHaveBeenCalledTimes(2)
    for (const call of navigate.mock.calls) {
      expect(call[0]).toEqual({
        kind: 'course-editor',
        organizationId: 'org-1',
        projectId: 'project-1',
        courseId: 'course-1',
        // WEB-35 — a create has no tab of its own to preserve, so the save
        // lands on General, same as the route this component built for the
        // `new-course` screen it came from.
        tab: 'general',
      })
      expect(call[1]).toEqual({ replace: true })
    }
  })

  it('does not render the previously opened project while the next one is still resolving', async () => {
    const navigate = vi.fn()
    const { rerender } = renderWithModal(
      <ProjectsPanel
        organizationId="org-1"
        route={{
          kind: 'project-courses',
          organizationId: 'org-1',
          projectId: 'project-1',
        }}
        navigate={navigate}
        onOpenChat={vi.fn()}
      />
    )

    expect(await screen.findByText('Autumn term')).toBeInTheDocument()

    // Everything from here is about the *next* project's open, so the
    // first project's own legitimate fetch is not what this asserts on.
    //
    // Waited for rather than assumed: the heading renders when the project
    // itself resolves, and this project's own `courses.list` is issued by a
    // separate effect that can still be a tick behind it. Clearing the mock
    // on the heading alone let that legitimate call land *after* the clear
    // under load, where the loop below reads it as the stale-fetch defect —
    // a failure of the test's timing, not of the component.
    await waitFor(() =>
      expect(listCourses).toHaveBeenCalledWith(expect.anything(), 'project-1')
    )
    listCourses.mockClear()

    // Back to the list, then straight into the *other* project — the
    // sequence a reader produces with the Back button and one click.
    rerender(
      withModal(
        <ProjectsPanel
          organizationId="org-1"
          route={{ kind: 'projects', organizationId: 'org-1' }}
          navigate={navigate}
          onOpenChat={vi.fn()}
        />
      )
    )

    // WEB-42: `Projects` itself now fetches every listed project's own
    // courses, to list them beneath each row — a legitimate `project-1`
    // call this test is not about. Waited for and cleared here, the same
    // way the fetch above already was, so it cannot be mistaken by the
    // loop below for the *next* transition's stale-resolution defect.
    await waitFor(() =>
      expect(listCourses).toHaveBeenCalledWith(expect.anything(), 'project-1')
    )
    listCourses.mockClear()

    rerender(
      withModal(
        <ProjectsPanel
          organizationId="org-1"
          route={{
            kind: 'project-courses',
            organizationId: 'org-1',
            projectId: 'project-2',
          }}
          navigate={navigate}
          onOpenChat={vi.fn()}
        />
      )
    )

    // Fails without the fix: the resolution effect returned early for the
    // `'projects'` route without clearing the previous project, so the old
    // project's heading rendered again for one commit — and its own
    // `courses.list` was issued — before the new one resolved.
    expect(screen.queryByText('Autumn term')).not.toBeInTheDocument()
    expect(await screen.findByText('Spring term')).toBeInTheDocument()
    // The other half of the same defect: the stale `'ready'` resolution
    // also issued the *previous* project's `courses.list` again on the way
    // into the new one.
    for (const call of listCourses.mock.calls) {
      expect(call[1]).not.toBe('project-1')
    }
  })
})
