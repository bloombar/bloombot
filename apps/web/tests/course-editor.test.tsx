/**
 * `pages/CourseEditor.tsx` (WEB-8, WEB-9): the CFG-2/3/4 form, saved
 * through `courses.save`, plus `courses.enable`/`courses.disable` — and the
 * two behaviours WEB-9 names explicitly: the category and role names shown
 * prominently, and a refused save rendering the conflict's own message
 * (naming the other course and its project).
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type {
  Course,
  DiscordServerBindingSummary,
  Project,
} from '../src/api/types.js'
import { CourseEditor } from '../src/pages/CourseEditor.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  getCourse,
  saveCourse,
  enableCourse,
  disableCourse,
  listCourseAttachments,
  listCourseInstructionRevisions,
  saveCourseInstructions,
  listCourseJoinLinks,
  listCourseWebSources,
  listCourseEnrolments,
  listDiscordServers,
} = vi.hoisted(() => ({
  getCourse: vi.fn(),
  saveCourse: vi.fn(),
  enableCourse: vi.fn(),
  disableCourse: vi.fn(),
  listCourseAttachments: vi.fn(),
  listCourseInstructionRevisions: vi.fn(),
  saveCourseInstructions: vi.fn(),
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
    enableCourse,
    disableCourse,
    listCourseAttachments,
    listCourseInstructionRevisions,
    saveCourseInstructions,
    listCourseJoinLinks,
    listCourseWebSources,
    listCourseEnrolments,
    listDiscordServers,
  }
})

// WEB-18/WEB-19/WEB-20/WEB-22/FILE-6: every "existing course" case in this
// file renders `components/CourseAttachments.tsx`,
// `components/CourseInstructions.tsx`, `components/JoinLinks.tsx`,
// `components/CourseWebSources.tsx` and `components/CoursePeople.tsx` too,
// each of which fetches on mount — an empty list by default so none of
// those requests ever goes un-stubbed here; `tests/course-attachments.test.tsx`,
// `tests/course-instructions.test.tsx`, `tests/join-links.test.tsx`,
// `tests/course-web-sources.test.tsx` and `tests/course-people.test.tsx` are
// what actually exercise those components' own behaviour.
// `components/RosterImport.tsx` fetches nothing on mount (it only ever calls
// out once an instructor picks a file and clicks Import), so it needs no
// stub here.
beforeEach(() => {
  listCourseAttachments.mockResolvedValue([])
  listCourseInstructionRevisions.mockResolvedValue([])
  listCourseJoinLinks.mockResolvedValue([])
  listCourseWebSources.mockResolvedValue([])
  listCourseEnrolments.mockResolvedValue([])
  // TEN-9 — no active bindings by default, so the server selector stays
  // hidden unless a test opts into two or more (`activeBindings.length > 1`,
  // `pages/CourseEditor.tsx`'s own guard); individual tests below override
  // this where the selector is what they are actually testing.
  listDiscordServers.mockResolvedValue([])
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
  discordServerId: null,
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
    renderWithModal(
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
    // MDL-8: no new course may acquire a stored prompt id — the field
    // is not offered at all, not merely blank.
    expect(screen.queryByLabelText('Prompt id')).not.toBeInTheDocument()
  })

  it('editing an existing course prefills the form from courses.get', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
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

    renderWithModal(
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
    // MDL-8: `promptId` is the one deliberate exception to "every other
    // unedited nullable field is still sent explicitly" — this form has no
    // control that can change it any more, so it is never sent at all,
    // relying on `courses.save`'s own "omitted preserves what is stored"
    // to keep this course answered through it, unchanged.
    expect(input).not.toHaveProperty('promptId')
    // `categories` is sent too, and carries the fetched course's own
    // categories/channels — not dropped, and not an empty replacement
    // (finding 1 of the WEB-7 rework: a `handleSave` that hard-coded
    // `categories: []` left this whole suite green while every saved
    // course's categories vanished).
    expect(input).toHaveProperty('categories', [
      {
        name: 'Web Design - GLOBAL',
        channels: [{ name: 'announcements', adminsOnly: false }],
      },
    ])
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

    renderWithModal(
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

  it('a non-numeric "Max requests per day" refuses the save rather than silently clearing the stored cap (finding 2)', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // Fat-finger the cap: '5O' (letter O), not '50'.
    fireEvent.change(screen.getByLabelText('Max requests per day'), {
      target: { value: '5O' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'maxRequestsPerDay'
    )
    // WEB-16: the refusal also names the field and appears *next to it* —
    // not only in the summary at the top of a fourteen-field form.
    const field = screen.getByLabelText('Max requests per day')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription(/whole number greater than zero/)
    // Never reaches the API at all — `Number('5O')` is `NaN`, which
    // `JSON.stringify` would have turned into `null` and cleared the
    // stored cap silently had this gone through.
    expect(saveCourse).not.toHaveBeenCalled()
  })

  it('a failed load renders only the failure, never an editable blank form over a real course (finding 3)', async () => {
    getCourse.mockRejectedValue(new ApiError(404, { error: 'action_refused' }))

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
    // No form at all — nothing fillable or saveable standing in for the
    // course that failed to load.
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save course' })
    ).not.toBeInTheDocument()
  })

  it('a save refused after ticking Enabled leaves the live toggle reading "Enable", not "Disable" (finding 4)', async () => {
    getCourse.mockResolvedValue({ ...COURSE, enabled: false })
    saveCourse.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: {
          message:
            'Category name "GLOBAL" is already used by course "Intro to CS" in project "Fall 2026".',
        },
      })
    )

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument()

    // Tick the checkbox (a pending edit) and hit a refused save.
    fireEvent.click(screen.getByLabelText(/^Enabled$/))
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))
    await screen.findByRole('alert')

    // The checkbox reflects the pending edit, but the live toggle still
    // reads the server-confirmed state — never enabled, so still "Enable,"
    // not "Disable" for a course that was never actually enabled.
    expect(screen.getByLabelText(/^Enabled$/)).toBeChecked()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Disable' })
    ).not.toBeInTheDocument()
  })

  it('enable and disable dispatch the dedicated actions, not a resave', async () => {
    getCourse.mockResolvedValue({ ...COURSE, enabled: false })
    disableCourse.mockResolvedValue({ disabled: true })
    enableCourse.mockResolvedValue({ enabled: true })

    renderWithModal(
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

/**
 * TEN-9 — the server selector: offered only once there is an actual choice
 * ("one binding is not a choice worth making anybody make", the brief's own
 * words), and threaded through to `courses.save` only while it is offered.
 */
describe('CourseEditor Discord server selector (TEN-9)', () => {
  const BINDING_A: DiscordServerBindingSummary = {
    serverId: 'guild-a',
    organizationId: 'org-1',
    installedByAccountId: 'account-1',
    installedAt: 0,
    removedAt: null,
  }
  const BINDING_B: DiscordServerBindingSummary = {
    serverId: 'guild-b',
    organizationId: 'org-1',
    installedByAccountId: 'account-1',
    installedAt: 0,
    removedAt: null,
  }

  it('stays hidden when the organization holds zero or one active binding', async () => {
    listDiscordServers.mockResolvedValue([BINDING_A])
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    expect(screen.queryByLabelText('Discord server')).not.toBeInTheDocument()
  })

  it('offers a choice once the organization holds two or more active bindings, and saves the one chosen', async () => {
    listDiscordServers.mockResolvedValue([BINDING_A, BINDING_B])
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue({ ...COURSE, discordServerId: 'guild-b' })

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    const select = await screen.findByLabelText('Discord server')
    fireEvent.change(select, { target: { value: 'guild-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ discordServerId: 'guild-b' })
      )
    )
  })

  it('does not send discordServerId at all while the selector is hidden — never forces every course to null the moment a second server is installed', async () => {
    listDiscordServers.mockResolvedValue([])
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() => expect(saveCourse).toHaveBeenCalled())
    const [, sentInput] = saveCourse.mock.calls[0] as [string, object]
    expect(sentInput).not.toHaveProperty('discordServerId')
  })

  // Must-fix 3 (coordinator round 1 rework): a course pinned to a
  // since-removed binding must stay recoverable in the panel — before this
  // fix, `activeBindings.length > 1` alone made the selector disappear the
  // moment the organization dropped back to one active binding, and
  // `handleSave`'s own omission (the test above) then preserved the stale
  // id forever, with nothing in the product to fix it.
  it('shows the selector for a course pinned to a binding that is no longer active, even though only one binding remains active', async () => {
    // `guild-b` (what `COURSE` below is pinned to) is not in this list at
    // all — the organization removed it, and now holds only `guild-a`.
    listDiscordServers.mockResolvedValue([BINDING_A])
    getCourse.mockResolvedValue({ ...COURSE, discordServerId: 'guild-b' })
    saveCourse.mockResolvedValue({ ...COURSE, discordServerId: 'guild-a' })

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // The selector renders — not hidden by `activeBindings.length > 1`
    // alone — and the stale id is shown, not silently blank.
    const select = await screen.findByLabelText('Discord server')
    expect(select).toHaveValue('guild-b')
    expect(screen.getByText(/guild-b \(no longer active\)/)).toBeInTheDocument()

    // Re-pointing to the one active binding is possible, and is sent.
    fireEvent.change(select, { target: { value: 'guild-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ discordServerId: 'guild-a' })
      )
    )
  })

  it('clearing a stale server assignment back to null is also possible, and sent explicitly', async () => {
    listDiscordServers.mockResolvedValue([BINDING_A])
    getCourse.mockResolvedValue({ ...COURSE, discordServerId: 'guild-b' })
    saveCourse.mockResolvedValue({ ...COURSE, discordServerId: null })

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    const select = await screen.findByLabelText('Discord server')
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ discordServerId: null })
      )
    )
  })
})

/**
 * MDL-8: a course with a stored prompt id is answered through it —
 * `buildResponsesRequestBody` (`packages/openai`) sends `prompt` instead of
 * `instructions` whenever one is set — so this form must say so plainly
 * rather than let an instructor edit Instructions believing it does
 * anything. The field itself becomes read-only and disappears entirely for
 * a course that has none, or one not yet saved.
 */
describe('CourseEditor stored-prompt notice (MDL-8)', () => {
  // WEB-18: the vector store is the platform's own bookkeeping, and offering
  // a text box for it beside a knowledge-files list would give an instructor
  // two contradictory ways to say what a course is grounded in.
  it('offers no vector store id field, and a save preserves the one a course already had', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    expect(screen.queryByLabelText('Vector store id')).toBeNull()

    // The deprecation must not blank an inherited value on the next
    // unrelated save — a course answered through a hand-typed store keeps
    // being answered through it.
    fireEvent.click(screen.getByRole('button', { name: /Save course/ }))
    await waitFor(() => expect(saveCourse).toHaveBeenCalled())
    // Never sent, rather than sent back: `courses.save`'s own "omitted
    // preserves what is stored" rule is what keeps an inherited store
    // attached, the same way the prompt id is preserved.
    expect(saveCourse.mock.calls[0]?.[1] ?? {}).not.toHaveProperty(
      'vectorStoreId'
    )
  })

  it('a course with a stored prompt id shows the notice and the id, read-only', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    expect(
      screen.getByText(/answered through a stored OpenAI prompt/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/instructions below are not being used/)
    ).toBeInTheDocument()
    const field = screen.getByLabelText('Prompt id')
    expect(field).toHaveValue('prompt-1')
    expect(field).toHaveAttribute('readonly')

    // Read-only, not merely styled — typing into it changes nothing.
    fireEvent.change(field, { target: { value: 'something-else' } })
    expect(field).toHaveValue('prompt-1')
  })

  it('a course with no stored prompt id shows neither the notice nor the field', async () => {
    getCourse.mockResolvedValue({ ...COURSE, promptId: null })

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    expect(
      screen.queryByText(/answered through a stored OpenAI prompt/)
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Prompt id')).not.toBeInTheDocument()
  })

  it('saving a course that already has a stored prompt id never sends promptId — courses.save preserves it by omission', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() => expect(saveCourse).toHaveBeenCalledTimes(1))
    const [, input] = saveCourse.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(input).not.toHaveProperty('promptId')
  })
})

/**
 * WEB-15: "removing a category"/"removing a channel" confirm before
 * anything is actually removed from the list — this file's own module
 * comment on `removeCategory`/`removeChannel` names "removing from a list"
 * as one of this panel's own destructive intents. A reviewer proved this
 * had no test at all: replacing `const confirmed = await confirm({...})`
 * with `const confirmed = true` in `CourseEditor.tsx` left the entire
 * suite green.
 */
describe('CourseEditor remove-category / remove-channel confirmation (WEB-15)', () => {
  it('removing a category confirms first; cancelling keeps it', async () => {
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    fireEvent.change(screen.getByLabelText('Category name'), {
      target: { value: 'Web Design - GLOBAL' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Remove category/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove Web Design - GLOBAL?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(dialog).not.toBeVisible())

    // Cancelling kept the category — its own name field is still there.
    expect(screen.getByLabelText('Category name')).toHaveValue(
      'Web Design - GLOBAL'
    )
  })

  it('removing a category, confirmed, actually removes it — and every channel inside it', async () => {
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    fireEvent.change(screen.getByLabelText('Category name'), {
      target: { value: 'Web Design - GLOBAL' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), {
      target: { value: 'announcements' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Remove category/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove Web Design - GLOBAL?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(screen.queryByLabelText('Category name')).not.toBeInTheDocument()
    )
    // The channel inside it is gone too — never orphaned.
    expect(screen.queryByLabelText('Channel name')).not.toBeInTheDocument()
  })

  it('removing a channel confirms first; cancelling keeps it', async () => {
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), {
      target: { value: 'announcements' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Remove channel/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove announcements?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(dialog).not.toBeVisible())

    expect(screen.getByLabelText('Channel name')).toHaveValue('announcements')
  })

  it('removing a channel, confirmed, actually removes only that channel', async () => {
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }))
    fireEvent.change(screen.getByLabelText('Channel name'), {
      target: { value: 'announcements' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }))
    const channelInputs = screen.getAllByLabelText('Channel name')
    fireEvent.change(channelInputs[1]!, { target: { value: 'general' } })

    fireEvent.click(
      screen.getAllByRole('button', { name: /Remove channel/ })[0]!
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove announcements?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(screen.getAllByLabelText('Channel name')).toHaveLength(1)
    )
    // The category itself, and its other channel, survive — only the
    // confirmed one was removed.
    expect(screen.getByLabelText('Category name')).toBeInTheDocument()
    expect(screen.getByLabelText('Channel name')).toHaveValue('general')
  })
})

/**
 * WEB-16: the unsaved-changes guard on this form's own Cancel control —
 * `useUnsavedChangesGuard`'s cross-component path (a navigation started
 * outside the form, e.g. `pages/Shell.tsx`'s own nav) is
 * `tests/navigation-guard.test.tsx`'s own scenario; this file's job is the
 * form's own exit.
 */
describe('CourseEditor unsaved-changes guard (WEB-16)', () => {
  it('a clean Cancel leaves without prompting at all', async () => {
    const onCancel = vi.fn()
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Fall 2026/ }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a dirty Cancel prompts; cancelling the prompt keeps the values and does not leave', async () => {
    const onCancel = vi.fn()
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Intro to Testing' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Fall 2026/ }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Discard unsaved changes?',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(onCancel).not.toHaveBeenCalled()
    // The typed value is still there — "keep editing" discards nothing.
    expect(screen.getByLabelText('Title')).toHaveValue('Intro to Testing')
  })

  it('a dirty Cancel prompts; confirming discards and leaves', async () => {
    const onCancel = vi.fn()
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Intro to Testing' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Fall 2026/ }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  it('a value typed and then reverted to its original counts as clean — no prompt', async () => {
    const onCancel = vi.fn()
    getCourse.mockResolvedValue(COURSE)
    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Something else' },
    })
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Fall 2026/ }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a successful save clears the dirty state — Cancel right after does not prompt', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)
    const onCancel = vi.fn()
    const onSaved = vi.fn()

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={onSaved}
        onCancel={onCancel}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: /Fall 2026/ }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // Rework finding (must-fix 2): `instructionsDirty` folded into this
  // page's own `isDirty` (`|| instructionsDirty`, this file's own module
  // comment on why) had no test of its own — deleting the fold left every
  // other test in this suite, and the whole rest of the app's suite, green.
  // `components/CourseInstructions.tsx` manages the Instructions textarea
  // entirely outside `form`/`baseline`, so only a case that edits
  // *Instructions alone*, leaving the rest of the form untouched, actually
  // exercises the bridge rather than `useFormDirty(baseline, form)` on its
  // own.
  it('an unsaved Instructions edit alone still prompts on Cancel — the WEB-19 dirty bridge', async () => {
    const onCancel = vi.fn()
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // Nothing in the main form's own fields changes — only the Instructions
    // textarea, which `pages/CourseEditor.tsx` no longer manages at all
    // (WEB-19).
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Fall 2026/ }))
    await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })

  it('a successful Instructions save clears the dirty bridge — Cancel right after does not prompt', async () => {
    const onCancel = vi.fn()
    getCourse.mockResolvedValue(COURSE)
    saveCourseInstructions.mockResolvedValue({
      ...COURSE,
      instructions: 'Cite the syllabus.',
    })
    // Empty on the initial mount (so the textarea starts blank and the
    // edit below is actually dirty), then the one revision the save
    // records — the refreshed read `CourseInstructions.tsx`'s own
    // `refresh` does after a successful save.
    listCourseInstructionRevisions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'rev-1',
          instructions: 'Cite the syllabus.',
          savedByAccountId: 'account-1',
          createdAt: Date.now(),
        },
      ])

    renderWithModal(
      <CourseEditor
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
    // Waits for the save's own `refresh()` to finish, not merely for the
    // save to have been dispatched — "Current" only renders once the
    // second, post-save `listCourseInstructionRevisions` read resolves.
    await screen.findByText('Current')
    // `instructionsDirty` itself clears one render later than "Current" —
    // `CourseInstructions`'s own dirty effect (reading the `text`/`baseline`
    // that just settled) runs, then calls `onDirtyChange`, which is a
    // *second* component's state update (`pages/CourseEditor.tsx`'s own
    // `setInstructionsDirty`) — a tick lets that propagate before Cancel is
    // clicked, the same wait `tests/navigation-guard.test.tsx` already uses
    // for the same "a guard's own effect needs a tick" reason.
    await new Promise((resolve) => setTimeout(resolve, 0))

    fireEvent.click(screen.getByRole('button', { name: /Fall 2026/ }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
