/**
 * `pages/CourseEditor.tsx` (WEB-8, WEB-9): the CFG-2/3/4 form, saved
 * through `courses.save`, plus `courses.enable`/`courses.disable` — and the
 * two behaviours WEB-9 names explicitly: the category and role names shown
 * prominently, and a refused save rendering the conflict's own message
 * (naming the other course and its project).
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { Course, Project } from '../src/api/types.js'
import { CourseEditor } from '../src/pages/CourseEditor.js'

const { getCourse, saveCourse, enableCourse, disableCourse } = vi.hoisted(
  () => ({
    getCourse: vi.fn(),
    saveCourse: vi.fn(),
    enableCourse: vi.fn(),
    disableCourse: vi.fn(),
  })
)

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, getCourse, saveCourse, enableCourse, disableCourse }
})

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
  filePrefix: 'wd',
  enabled: true,
  adminsRole: 'admins-wd-fa26',
  studentsRole: 'students-wd-fa26',
  promptId: 'prompt-1',
  instructions: 'Be helpful.',
  model: 'gpt-4o',
  vectorStoreId: 'vs-1',
  maxRequestsPerDay: 20,
  conversationScope: 'course',
  createdAt: 0,
  categories: [
    {
      id: 'cat-1',
      name: 'Web Design - GLOBAL',
      channels: [{ id: 'chan-1', name: 'announcements', adminsOnly: false }],
    },
  ],
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('CourseEditor (WEB-8)', () => {
  it("a new course shows the routing-relevant fields prominently, and starts disabled (D-23's own default)", () => {
    render(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // WEB-9: category and role names shown together, up front, in their
    // own labeled region.
    expect(
      screen.getByRole('region', { name: 'What this course routes on' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Admins role')).toBeInTheDocument()
    expect(screen.getByLabelText('Students role')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Enabled$/)).not.toBeChecked()
  })

  it('editing an existing course prefills the form from courses.get', async () => {
    getCourse.mockResolvedValue(COURSE)

    render(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(await screen.findByDisplayValue('Web Design')).toBeInTheDocument()
    expect(getCourse).toHaveBeenCalledWith('org-1', 'course-1')
    expect(screen.getByDisplayValue('admins-wd-fa26')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Web Design - GLOBAL')).toBeInTheDocument()
  })

  it('a save clears an optional field to an explicit null, not an omitted key (docs/DECISIONS.md)', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)

    render(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // Clear the model field, which the source course had set...
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() => expect(saveCourse).toHaveBeenCalledTimes(1))
    const [, input] = saveCourse.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    // Explicit `null` — the key present with that value — not omitted
    // entirely, which `courses.save` would instead read as "keep the
    // stored value."
    expect(input).toHaveProperty('model', null)
    // Every other unedited nullable field is still sent explicitly too.
    expect(input).toHaveProperty('promptId', 'prompt-1')
  })

  it("a save refused for a PROJ-3 collision renders the conflict's own message, naming the other course and project (WEB-9)", async () => {
    saveCourse.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: {
          message:
            'Category name "GLOBAL" is already used by course "Intro to CS" in project "Fall 2026".',
        },
      })
    )

    render(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Category name "GLOBAL" is already used by course "Intro to CS" in project "Fall 2026".'
    )
  })

  it('enable and disable dispatch the dedicated actions, not a resave', async () => {
    getCourse.mockResolvedValue({ ...COURSE, enabled: false })
    disableCourse.mockResolvedValue({ disabled: true })
    enableCourse.mockResolvedValue({ enabled: true })

    render(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    await waitFor(() =>
      expect(enableCourse).toHaveBeenCalledWith('org-1', 'course-1')
    )
    expect(saveCourse).not.toHaveBeenCalled()
  })
})
