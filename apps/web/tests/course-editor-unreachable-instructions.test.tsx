/**
 * Round 2, finding 2: `pages/CourseEditor.tsx`'s own `saveDirtyWork`
 * refuses when an unsaved instructions edit exists but the handles for it
 * do not (`instructionsActionsRef` is `null`) — review round 1's must-fix
 * 4. That state is unreachable through the real
 * `components/CourseInstructions.tsx`, because a tab, once visited, stays
 * mounted and the section re-registers its handles on every change; a test
 * driving the real component therefore cannot reach the branch at all,
 * which is exactly why the fix shipped with no coverage and reverting it
 * left the suite green.
 *
 * So this file stubs that component with one that reports itself dirty and
 * never registers anything — the shape the guard exists for. It lives in
 * its own file because `vi.mock` is hoisted per module, and the rest of
 * the course-editor suite needs the real component.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Course, Project } from '../src/api/types.js'
import { CourseEditor } from '../src/pages/CourseEditor.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  getCourse,
  saveCourse,
  disableCourse,
  listCourseAttachments,
  listCourseJoinLinks,
  listCourseWebSources,
  listCourseEnrolments,
  listDiscordServers,
} = vi.hoisted(() => ({
  getCourse: vi.fn(),
  saveCourse: vi.fn(),
  disableCourse: vi.fn(),
  listCourseAttachments: vi.fn(),
  listCourseJoinLinks: vi.fn(),
  listCourseWebSources: vi.fn(),
  listCourseEnrolments: vi.fn(),
  listDiscordServers: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    getCourse,
    saveCourse,
    disableCourse,
    listCourseAttachments,
    listCourseJoinLinks,
    listCourseWebSources,
    listCourseEnrolments,
    listDiscordServers,
  }
})

// The stub: dirty from the moment it mounts, and no `onRegisterActions`
// call ever — an unsaved edit this page has no way to reach.
//
// `onDirtyChange` is reported from an effect rather than during render.
// Calling it inline sets state on `CourseEditor` while this component is
// rendering, which React defers (it warns about exactly this), so
// `instructionsDirty` was not reliably applied by the time the test
// clicked a tab — the click then found a clean form, no prompt opened,
// and the test failed under load while passing in isolation. The effect
// runs in the commit phase instead, and `reported` below is the test's
// gate: it renders only once the parent has been told, so waiting for it
// guarantees the state this test depends on is in place.
vi.mock('../src/components/CourseInstructions.js', () => ({
  CourseInstructions: ({
    onDirtyChange,
  }: {
    onDirtyChange: (dirty: boolean) => void
  }) => {
    const [reported, setReported] = useState(false)
    useEffect(() => {
      onDirtyChange(true)
      setReported(true)
    }, [onDirtyChange])
    return (
      <div data-testid="course-instructions-stub">
        {reported && <span data-testid="course-instructions-stub-dirty" />}
      </div>
    )
  },
}))

const PROJECT: Project = {
  id: 'project-1',
  organizationId: 'org-1',
  name: 'Fall 2026',
  archivedAt: null,
  createdAt: 0,
}

const COURSE: Course = {
  id: 'course-1',
  organizationId: 'org-1',
  projectId: 'project-1',
  title: 'Web Design',
  enabled: true,
  adminsRole: 'admins-wd-fa26',
  studentsRole: 'students-wd-fa26',
  promptId: 'prompt-1',
  instructions: 'Be helpful.',
  model: 'gpt-4o',
  vectorStoreId: 'vs-1',
  maxRequestsPerDay: 20,
  conversationScope: 'course',
  discordServerId: null,
  createdAt: 0,
  categories: [],
}

beforeEach(() => {
  listCourseAttachments.mockResolvedValue([])
  listCourseJoinLinks.mockResolvedValue([])
  listCourseWebSources.mockResolvedValue([])
  listCourseEnrolments.mockResolvedValue([])
  listDiscordServers.mockResolvedValue([])
  getCourse.mockResolvedValue(COURSE)
})

describe('CourseEditor with an unreachable instructions edit (review round 1, must-fix 4)', () => {
  it('refuses to move the tab rather than treating an unreachable edit as saved', async () => {
    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onNavigateTab={vi.fn()}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByTestId('course-instructions-stub-dirty')

    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // Fails with the pre-fix `savedInstructions === false` check: an
    // absent ref resolved `undefined`, which is not `false`, so the edit
    // counted as saved and the tab moved with it still unsaved and still
    // unreachable.
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tab', { name: 'Discord' })).toHaveAttribute(
      'aria-selected',
      'false'
    )
    // Nothing was sent on either half.
    expect(saveCourse).not.toHaveBeenCalled()
  })
})
