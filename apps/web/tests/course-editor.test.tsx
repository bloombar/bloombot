/**
 * `pages/CourseEditor.tsx` (WEB-8, WEB-9): the CFG-2/3/4 form, saved
 * through `courses.save` — `disableCourse` is still mocked, but only so a
 * case can assert this screen never calls it (WEB-37: the immediate
 * enable/disable control lives on the project page now) — and the
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
import { renderWithModal, withModal } from './helpers/render-with-modal.js'

const {
  getCourse,
  saveCourse,
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
  enabled: true,
  adminsRole: 'admins-wd-fa26',
  studentsRole: 'students-wd-fa26',
  promptId: 'prompt-1',
  instructions: 'Be helpful.',
  model: 'gpt-4o',
  vectorStoreId: 'vs-1',
  maxRequestsPerDay: 20,
  conversationScope: 'course',
  selfEnrolFromDiscord: false,
  answerUnenrolled: true,
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

/**
 * WEB-43: the single, always-present `role="status"` node beside `Save
 * course` (review round 1, must-fix 3: one node whose *text* changes, not
 * three that mount and unmount) — scoped to the button's own wrapper `div`
 * rather than queried by accessible name (`role="status"` does not compute
 * one from its own text content, unlike a `button`, so `getByRole('status',
 * { name: … })` never matches regardless of what the status actually says),
 * and rather than by text, since other sections on this same screen
 * (`JoinLinks`, `CoursePeople`, …) render their own `role="status"` nodes
 * that would otherwise collide with an unscoped query. Returns the element
 * itself — assert against it with `toHaveTextContent`, not `findByText`,
 * since it exists (with empty text) even in the idle state.
 */
function saveCourseStatus(): HTMLElement {
  const button = screen.getByRole('button', { name: 'Save course' })
  return within(button.parentElement as HTMLElement).getByRole('status')
}

describe('CourseEditor (WEB-8)', () => {
  it("a new course shows the routing-relevant fields prominently, and starts disabled (D-23's own default)", () => {
    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(await screen.findByDisplayValue('Web Design')).toBeInTheDocument()
    expect(getCourse).toHaveBeenCalledWith('org-1', 'course-1')

    // WEB-35: the role names and categories are on the Discord tab now.
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    expect(screen.getByDisplayValue('admins-wd-fa26')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Web Design - GLOBAL')).toBeInTheDocument()
  })

  it('a save clears an optional field to an explicit null, not an omitted key (docs/DECISIONS.md)', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: Model is on the AI tab.
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: Max requests per day is on the AI tab.
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
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

  // Rework round 1, must-fix 7: `switchToTabForField` had no coverage at
  // all for the client-side `maxRequestsPerDay` refusal — every existing
  // case already started on the AI tab, so a version that only switched
  // tabs for a *server*-refused save would have passed this suite
  // unnoticed.
  it('a client-side "Max requests per day" refusal switches to the AI tab when it is not already showing', async () => {
    getCourse.mockResolvedValue(COURSE)

    const { rerender } = renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Model')

    // Fat-finger the cap while on the AI tab...
    fireEvent.change(screen.getByLabelText('Max requests per day'), {
      target: { value: '5O' },
    })
    // ...then leave, without saving, to a tab with nothing wrong on it.
    // Through the `tab` prop, i.e. a browser Back — the one route to
    // another tab that deliberately does *not* go through the
    // unsaved-changes prompt (`routing/useRoute.ts`'s own `popstate`
    // handler bypasses the guard for a same-screen pop, WEB-34), and so
    // the one route that can still strand a bad value on a hidden tab.
    rerender(
      withModal(
        <CourseEditor
          navigate={vi.fn()}
          organizationId="org-1"
          project={PROJECT}
          courseId="course-1"
          tab="general"
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    )
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    // Fails without the fix: the client-side refusal fires before
    // `courses.save` is ever called, entirely inside `handleSave` itself —
    // a version of `switchToTabForField` only wired into the server-refused
    // catch would leave the reader on General, looking at a top-level
    // `ErrorMessage` with no field-level message anywhere in view.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    const field = screen.getByLabelText('Max requests per day')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(saveCourse).not.toHaveBeenCalled()
  })

  // WEB-45: the form/detail shape — a skeleton that resembles the field
  // grid below it, not merely the base pulsing block `App.tsx`'s
  // whole-screen gate uses.
  it('shows a field-shaped skeleton while loading, announces it to assistive technology, and swaps it for the real form once courses.get resolves', async () => {
    let resolveCourse: ((course: Course) => void) | undefined
    getCourse.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCourse = resolve
        })
    )

    const { container } = renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    // The decorative shapes are there (`aria-hidden`, so a screen reader
    // never sees them) alongside the one accessible announcement.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(
      0
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument()

    resolveCourse?.(COURSE)

    expect(await screen.findByDisplayValue('Web Design')).toBeInTheDocument()
    // The skeleton is gone once the real form has taken its place — the
    // same `.animate-pulse` check its sibling suites use, not a `role`
    // query: the loaded form renders several other `role="status"` nodes
    // of its own (WEB-20/WEB-22/WEB-43), so `getByRole('status')` would
    // throw on more than one match, and `queryByRole('status')` returning
    // any one of them would make `not.toHaveTextContent('Loading…')` pass
    // for the wrong reason.
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0)
  })

  it('a failed load renders only the failure, never an editable blank form over a real course (finding 3)', async () => {
    getCourse.mockRejectedValue(new ApiError(404, { error: 'action_refused' }))

    const { container } = renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
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
    // WEB-45 (Admin.tsx-style regression): a refusal never also shows a
    // skeleton claiming this is still loading.
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0)
  })

  // The immediate Enable/Disable button that used to sit beside this
  // checkbox is gone (`pages/CourseEditor.tsx`'s own `enabledControl`): one
  // flag, one control, saved with the rest of the form. The immediate
  // control lives on the project page's own per-course kebab menu
  // (`pages/Courses.tsx`, `tests/courses.test.tsx`).
  it('offers no immediate enable/disable control — the checkbox is the only one, and it saves with the form', async () => {
    getCourse.mockResolvedValue({ ...COURSE, enabled: true })
    saveCourse.mockResolvedValue({ ...COURSE, enabled: false })

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // Fails before the change: both buttons were rendered here, reading
    // the server-confirmed state.
    expect(
      screen.queryByRole('button', { name: 'Disable' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Enable' })
    ).not.toBeInTheDocument()

    // Unticking and saving is what disables the course now.
    expect(screen.getByLabelText(/^Enabled$/)).toBeChecked()
    fireEvent.click(screen.getByLabelText(/^Enabled$/))
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ id: 'course-1', enabled: false })
      )
    )
    expect(disableCourse).not.toHaveBeenCalled()
  })
})

/**
 * ENRL-13/ENRL-14 — the two checkboxes beside `enabledControl` on the
 * General tab. Each test fails without the code it names.
 */
describe('CourseEditor self-enrolment settings (ENRL-13/ENRL-14)', () => {
  it('renders both checkboxes reflecting the loaded course', async () => {
    getCourse.mockResolvedValue({
      ...COURSE,
      selfEnrolFromDiscord: true,
      answerUnenrolled: false,
    })

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    expect(
      screen.getByLabelText(
        'Students can enrol themselves by messaging this course'
      )
    ).toBeChecked()
    expect(
      screen.getByLabelText('Answer students who are not enrolled')
    ).not.toBeChecked()
  })

  it("a new course starts with today's defaults — self-enrol off, answer-unenrolled on", () => {
    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(
      screen.getByLabelText(
        'Students can enrol themselves by messaging this course'
      )
    ).not.toBeChecked()
    expect(
      screen.getByLabelText('Answer students who are not enrolled')
    ).toBeChecked()
  })

  it('ticking both boxes and saving sends both values with the rest of the General tab', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.click(
      screen.getByLabelText(
        'Students can enrol themselves by messaging this course'
      )
    )
    fireEvent.click(
      screen.getByLabelText('Answer students who are not enrolled')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          id: 'course-1',
          selfEnrolFromDiscord: true,
          answerUnenrolled: false,
        })
      )
    )
  })
})

/**
 * WEB-35: the settings tabs themselves — the address changes on a click,
 * an edit made on one tab survives switching to another, and a refused save
 * naming a field on a tab other than the one showing switches there so the
 * inline message is actually visible (WEB-16).
 */
describe('CourseEditor settings tabs (WEB-35)', () => {
  it('renders five tabs for an existing course, and none at all for a new one', async () => {
    getCourse.mockResolvedValue(COURSE)

    const { rerender } = renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    expect(screen.getByRole('tablist')).toBeInTheDocument()
    for (const name of ['General', 'AI', 'Discord', 'Roster', 'People']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }

    rerender(
      withModal(
        <CourseEditor
          navigate={vi.fn()}
          organizationId="org-1"
          project={PROJECT}
          courseId={undefined}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    )
    // A new course cannot have join links, a roster import, people,
    // attachments, instructions or websites — nothing here to tab between.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('switching tabs with nothing unsaved calls onNavigateTab and asks nothing', async () => {
    getCourse.mockResolvedValue(COURSE)
    const onNavigateTab = vi.fn()

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="general"
        onNavigateTab={onNavigateTab}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    expect(onNavigateTab).toHaveBeenCalledWith('ai')
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    // A clean form is never asked about — the same "a clean form leaves
    // with no prompt" rule WEB-16 already holds the whole-screen guard to.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // Rework round 1, must-fix 1/7: `CourseInstructions` keeps its own text in
  // its own `useState`, entirely outside `form`/`baseline`, and mounting
  // only the active tab's panel used to unmount it the moment its own tab
  // stopped being the one showing. A remount would re-fetch; staying
  // mounted does not, which is what this asserts.
  it('a panel already opened stays mounted across a tab switch, rather than re-fetching', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')
    await waitFor(() =>
      expect(listCourseInstructionRevisions).toHaveBeenCalledTimes(1)
    )

    // Away, to a tab with no relation to Instructions at all, and back.
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    expect(screen.getByLabelText('Instructions')).toBeInTheDocument()
    expect(listCourseInstructionRevisions).toHaveBeenCalledTimes(1)
  })

  // Rework round 1, must-fix 7: the Back/Forward re-seeding path — nothing
  // in the suite above ever re-rendered `CourseEditor` with a changed `tab`
  // prop alone, the one path a browser Back/Forward between tabs actually
  // takes (`routing/useRoute.ts`'s own `popstate` handler lets the new
  // `tab` prop through directly for a same-screen pop, `pages/CourseEditor.tsx`'s
  // own module comment).
  it('a changed tab prop alone (a browser Back/Forward between tabs) moves the active tab', async () => {
    getCourse.mockResolvedValue(COURSE)

    const { rerender } = renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Model')
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    // No click on any tab control — only the prop itself changes, the same
    // as `pages/ProjectsPanel.tsx` re-rendering this component once
    // `routing/useRoute.ts` moves `route.tab` in response to a pop.
    rerender(
      withModal(
        <CourseEditor
          navigate={vi.fn()}
          organizationId="org-1"
          project={PROJECT}
          courseId="course-1"
          tab="roster"
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    )

    expect(screen.getByRole('tab', { name: 'Roster' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })

  it('a refused save naming a field on another tab switches to that tab so the inline message is visible', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockRejectedValue(
      new ApiError(400, {
        error: 'action_input_invalid',
        issues: [
          {
            path: ['adminsRole'],
            message: 'This role no longer exists on the bound Discord server.',
          },
        ],
      })
    )

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="general"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    // WEB-43: an edit is what makes the button clickable at all.
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    // Fails without the fix: `adminsRole`'s own `FormField` — and its
    // inline error — lives on the Discord tab, not General.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Discord' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    // PROJ-7: the field's own "leave blank" help text is still part of its
    // accessible description alongside the refusal — both ids are in
    // `aria-describedby` (`FormField.tsx`'s own `describedBy`).
    expect(screen.getByLabelText('Admins role')).toHaveAccessibleDescription(
      'Leave blank if this course should not route on a role. This role no longer exists on the bound Discord server.'
    )
  })
})

/**
 * WEB-43: `Save course` reflects whether there is anything to save —
 * disabled on an unmodified form, enabled the moment either half of the
 * shared `isDirty` goes dirty, and accompanied by a `Saving…`/`Saved`
 * status beside it rather than a relabelled button. Every test here fails
 * without the change: before it, the button was only ever gated on
 * `saving`/`switchSaving`, live on a form nobody had touched.
 *
 * Review round 1: the "shows Saved" case below is split into an
 * appears-case (a long `savedClearAfterMs`, so the assertion cannot lose a
 * race against the clearing timer) and a clears-case (a short one, which
 * only has to observe the eventual return to the idle state — see that
 * test's own comment for why it does not also assert the appearance).
 */
describe('CourseEditor Save button reflects dirtiness (WEB-43)', () => {
  it('is disabled on first render of an unmodified, already-loaded form', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()
  })

  it('editing a field on the form enables it', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })

    expect(screen.getByRole('button', { name: 'Save course' })).toBeEnabled()
  })

  // The cross-tab case the shared `isDirty` exists for (`formDirty ||
  // instructionsDirty`, `pages/CourseEditor.tsx`) — and the easiest to
  // break, since the form's own fields never change at all here.
  it('an edit on the Instructions tab, via the dirty bridge, also enables it', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })

    expect(screen.getByRole('button', { name: 'Save course' })).toBeEnabled()
  })

  it('shows Saving… beside the button while a save is in flight, and the button keeps its own label', async () => {
    getCourse.mockResolvedValue(COURSE)
    let releaseSave: (course: Course) => void = () => {}
    saveCourse.mockReturnValue(
      new Promise<Course>((resolve) => {
        releaseSave = resolve
      })
    )

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() => expect(saveCourseStatus().textContent).toBe('Saving…'))
    // The button itself never says "Saving…" any more — only the status
    // beside it does.
    expect(
      screen.queryByRole('button', { name: 'Saving…' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()

    releaseSave({ ...COURSE, title: 'Web Design II' })
    await waitFor(() =>
      expect(saveCourseStatus().textContent).not.toBe('Saving…')
    )
  })

  it('shows Saving… beside the button for a tab-switch save too', async () => {
    getCourse.mockResolvedValue(COURSE)
    let releaseSave: (course: Course) => void = () => {}
    saveCourse.mockReturnValue(
      new Promise<Course>((resolve) => {
        releaseSave = resolve
      })
    )

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="general"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(saveCourseStatus().textContent).toBe('Saving…'))
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()

    releaseSave({ ...COURSE, title: 'Web Design II' })
    await waitFor(() =>
      expect(saveCourseStatus().textContent).not.toBe('Saving…')
    )
  })

  it('shows Saved and disables the button again after a successful save', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue({ ...COURSE, title: 'Web Design II' })

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        // Review round 1, must-fix 1: deliberately long — this case is
        // only about whether `Saved` appears at all, and a short timer
        // here raced the clearing timer against the assertion below
        // (`findByText`/`waitFor` polling is not instantaneous), failing
        // this file under load without any real regression. The clearing
        // half of the behaviour has its own case, below, with its own
        // short timer.
        savedClearAfterMs={60_000}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() => expect(saveCourseStatus().textContent).toBe('Saved'))
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()
  })

  it('clears Saved once the timer elapses', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue({ ...COURSE, title: 'Web Design II' })

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        // Review round 1, must-fix 1: short, and deliberately not also
        // asserted as having shown "Saved" first (the case above already
        // covers that) — asserting both in one test, with one short timer,
        // is exactly the race that made the original version of this test
        // flaky under load. This only has to observe the eventual return
        // to idle, which a mutation that stops the timer from firing at
        // all (leaving "Saved" up forever) still catches.
        savedClearAfterMs={20}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))
    await waitFor(() => expect(saveCourse).toHaveBeenCalledTimes(1))

    await waitFor(() => expect(saveCourseStatus().textContent).toBe(''))
  })

  it('clears Saved immediately if the form is edited again before the timer elapses', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue({ ...COURSE, title: 'Web Design II' })

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        // A long timer — long enough that reaching the assertion below
        // before it would fire is not a race, so this failing would mean
        // the immediate-clear path, not the timer, cleared it.
        savedClearAfterMs={60_000}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))
    await waitFor(() => expect(saveCourseStatus().textContent).toBe('Saved'))

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design III' },
    })

    expect(saveCourseStatus().textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Save course' })).toBeEnabled()
  })

  it('never shows Saved after a failed save', async () => {
    getCourse.mockResolvedValue(COURSE)
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(saveCourseStatus().textContent).not.toBe('Saved')
  })

  // The half-saved path (`halfSaved`, `pages/CourseEditor.tsx`) already has
  // its own message; a "Saved" beside the button at the same time would
  // claim a form half that was actually refused.
  it('never shows Saved on the half-saved path, which keeps its own message', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourseInstructions.mockResolvedValue({ saved: true })
    saveCourse.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: { message: 'Category name "GLOBAL" is already used.' },
      })
    )

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'gpt-4o-mini' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(
      await screen.findByText(/instructions were saved before this was refused/)
    ).toBeInTheDocument()
    expect(saveCourseStatus().textContent).not.toBe('Saved')
  })

  // Review round 1, must-fix 2: a click on `Save course` while only the
  // *Instructions* half is dirty still runs `handleSave` (it always saves
  // the form, unconditionally) and that save genuinely succeeds — but the
  // Instructions edit itself is untouched by it, so `isDirty` is still
  // true afterward (`instructionsDirty` alone), and the button is still
  // enabled. `Saved` here would be exactly the lie the brief warned
  // against: a confirmation beside a form that still has unsaved work.
  // Fails without the fix: `justSaved` alone (no `!isDirty`) goes true on
  // this same successful save.
  it('does not show Saved when an Instructions edit is still unsaved after this save', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    // Enabled by the dirty bridge alone — no form field was touched.
    expect(screen.getByRole('button', { name: 'Save course' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))
    await waitFor(() => expect(saveCourse).toHaveBeenCalledTimes(1))

    // The form half saved cleanly, but the Instructions half — which this
    // click never sent — is still unsaved, and the button is still
    // enabled to prove it.
    expect(saveCourseStatus().textContent).not.toBe('Saved')
    expect(screen.getByRole('button', { name: 'Save course' })).toBeEnabled()
  })

  // Not asked for in the brief, and deliberately left as-is: a tab-switch
  // save where *only* the Instructions half is dirty never calls
  // `handleSave` at all (`saveDirtyWork`'s own `if (formDirty)` guard), so
  // it shows `Saving…` (`switchSaving` covers it) but never `Saved` —
  // there is no "the form saved" to confirm, since the form never sent
  // anything. Recorded here as the documented, chosen behaviour rather
  // than an oversight, so a future change to it is deliberate.
  it('a tab-switch save where only Instructions is dirty shows no Saved at all', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourseInstructions.mockResolvedValue({ saved: true })

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(saveCourseInstructions).toHaveBeenCalledTimes(1))
    expect(saveCourse).not.toHaveBeenCalled()
    expect(saveCourseStatus().textContent).not.toBe('Saved')
  })
})

/**
 * Leaving a tab with unsaved settings asks first, with three answers —
 * save them, discard them, or stay put (`pages/CourseEditor.tsx`'s own
 * `goToTabGuarded`). Every test here fails before that change: a tab click
 * switched immediately, unsaved edits and all.
 */
describe('CourseEditor unsaved-changes prompt on a tab switch', () => {
  const renderEditor = (onNavigateTab = vi.fn()) => {
    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="general"
        onNavigateTab={onNavigateTab}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    return onNavigateTab
  }

  it('Cancel keeps both the tab and the edit', async () => {
    getCourse.mockResolvedValue(COURSE)
    const onNavigateTab = renderEditor()
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    // Neither the tab nor the address moved, and the edit is untouched.
    expect(onNavigateTab).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Title')).toHaveValue('Web Design II')
    expect(saveCourse).not.toHaveBeenCalled()
  })

  it('Discard changes throws the edit away and switches', async () => {
    getCourse.mockResolvedValue(COURSE)
    const onNavigateTab = renderEditor()
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    expect(onNavigateTab).toHaveBeenCalledWith('ai')
    expect(saveCourse).not.toHaveBeenCalled()
    // Back on General, the form reads what the server last agreed to.
    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Title')).toHaveValue('Web Design')
    )
  })

  it('Save changes saves the form, then switches', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue({ ...COURSE, title: 'Web Design II' })
    const onNavigateTab = renderEditor()
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ id: 'course-1', title: 'Web Design II' })
      )
    )
    await waitFor(() => expect(onNavigateTab).toHaveBeenCalledWith('ai'))
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  // Review must-fix 2: a refusal naming no field this form renders leaves
  // the person exactly where they were. `mappedIssue` is `undefined` here
  // (a 409 carries a `conflict`, not `issues`), so `switchToTabForField`
  // does not fire at all — which is precisely why this case alone used to
  // pass over the defect the case below catches.
  it('a refused save naming no rendered field keeps the person on the tab, with the refusal on screen', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: {
          message:
            'Category name "GLOBAL" is already used by course "Intro to CS" in project "Fall 2026".',
        },
      })
    )
    const onNavigateTab = renderEditor()
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await screen.findByRole('alert')
    // Going anyway would have left the refusal behind on a tab nobody is
    // looking at.
    expect(onNavigateTab).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByLabelText('Title')).toHaveValue('Web Design II')
  })

  // Review must-fix 2, the case the 409 above hid: a refusal that *does*
  // name a field lands on that field's own tab (WEB-16), and never on the
  // tab the click asked for. Fails before the fix in the documentation
  // sense — the code went to Discord while WEB-38, the docblock and D-83
  // all promised General — and fails outright if anyone ever "fixes" the
  // code to the old prose, since the inline message would then render on a
  // tab nobody is looking at.
  it('a refused save naming a field lands on that field’s own tab, not on the tab the click asked for', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockRejectedValue(
      new ApiError(400, {
        error: 'action_input_invalid',
        issues: [
          {
            path: ['adminsRole'],
            message: 'This role no longer exists on the bound Discord server.',
          },
        ],
      })
    )
    const onNavigateTab = renderEditor()
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    // Ask for AI...
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // ...and land on Discord, where the refused field actually is.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Discord' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    // PROJ-7: see the other `toHaveAccessibleDescription` case's own
    // comment above — the field's "leave blank" help text is still part
    // of its accessible description alongside the refusal.
    expect(screen.getByLabelText('Admins role')).toHaveAccessibleDescription(
      'Leave blank if this course should not route on a role. This role no longer exists on the bound Discord server.'
    )
    // Not the tab the click asked for — though where a refusal lands is
    // the refused *field's* tab, which can coincide with the clicked one
    // (`model` and `maxRequestsPerDay` both live on AI). `adminsRole` is
    // chosen here precisely so the two differ and the assertion means
    // something (round 2, finding 1).
    expect(onNavigateTab).not.toHaveBeenCalledWith('ai')
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute(
      'aria-selected',
      'false'
    )
    expect(screen.getByLabelText('Title')).toHaveValue('Web Design II')
  })

  // Review must-fix 1: nothing consulted `saving`, so a tab click while
  // `Save course` was in flight found `baseline` unmoved, prompted, and
  // fired a second concurrent `courses.save` — two requests racing to set
  // `form`, `baseline` and `onSaved`.
  it('a tab click while a save is in flight neither prompts nor fires a second save', async () => {
    getCourse.mockResolvedValue(COURSE)
    let releaseSave: (course: Course) => void = () => {}
    saveCourse.mockReturnValue(
      new Promise<Course>((resolve) => {
        releaseSave = resolve
      })
    )
    const onNavigateTab = renderEditor()
    await screen.findByDisplayValue('Web Design')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))
    // WEB-43: the label stays `Save course` in every state now — `Saving…`
    // moved beside the button, as its own `role="status"`.
    await waitFor(() => expect(saveCourseStatus().textContent).toBe('Saving…'))
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    // No prompt, no navigation, and above all no second request.
    await waitFor(() => expect(saveCourse).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onNavigateTab).not.toHaveBeenCalled()

    releaseSave({ ...COURSE, title: 'Web Design II' })
    // WEB-43 (review round 1, must-fix 4): waiting on `toBeDisabled()`
    // alone is satisfied the instant this synchronous check runs — the
    // button is already disabled because `saving` is still true, so this
    // never actually waits for the save to settle. `Saved` only appears
    // once `saving` has cleared *and* the resolved save left the form
    // clean, so waiting for it is what proves the promise above actually
    // resolved and was applied, not merely disproved.
    await waitFor(() => expect(saveCourseStatus().textContent).toBe('Saved'))
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()
    expect(saveCourse).toHaveBeenCalledTimes(1)
  })

  // Review must-fix 1's mirror: while the prompt is awaiting the
  // *instructions* half, the form's own `saving` is still false — the Save
  // course button used to stay live right through that window.
  it('the Save course button is unavailable while the prompt is saving the instructions half', async () => {
    getCourse.mockResolvedValue(COURSE)
    let releaseInstructions: (value: unknown) => void = () => {}
    saveCourseInstructions.mockReturnValue(
      new Promise((resolve) => {
        releaseInstructions = resolve
      })
    )

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(saveCourseInstructions).toHaveBeenCalled())
    // WEB-43: the form's own button no longer relabels itself — it stays
    // `Save course`, disabled, with its own `Saving…` status beside it. One
    // "Saving…" *button* remains: the instructions section's own, which
    // this component does not touch.
    expect(screen.getAllByRole('button', { name: 'Saving…' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()
    expect(saveCourseStatus().textContent).toBe('Saving…')

    releaseInstructions({ saved: true })
    // WEB-43 (review round 1, must-fix 4): `toBeDisabled()` alone is
    // satisfied by the very next synchronous check — the button is
    // already disabled because `switchSaving` has not cleared yet, so a
    // bare `waitFor` here never actually waits for the release above to be
    // applied. Only the instructions half was ever dirty — the form itself
    // was clean the whole time, so `handleSave` never ran and there is
    // still nothing for `Save course` to save.
    //
    // Both assertions belong in the *same* `waitFor` callback, not two
    // separate ones run back to back: `switchSaving` clearing and
    // `instructionsDirty` clearing are two different pieces of state,
    // set from two different promise continuations (this component's own
    // `finally` versus `CourseInstructions`'s own save callback), and
    // nothing guarantees they commit in the same React render. Checking
    // the status text and the button disabled state as two sequential
    // `waitFor`s let the first succeed on a render where the text has
    // already cleared but `isDirty` has not yet, which read as flaky.
    // One `waitFor` that requires both at once only resolves once React
    // has actually settled into the final state.
    await waitFor(() => {
      expect(saveCourseStatus().textContent).toBe('')
      expect(screen.getByRole('button', { name: 'Save course' })).toBeDisabled()
    })
  })

  // Round 2, finding 4: the half-commit notice must not outlive the
  // refusal it explains — `discardDirtyWork` cleared `error` but not this.
  it('says when a save half-committed, and stops saying it once the rest is discarded', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourseInstructions.mockResolvedValue({ saved: true })
    saveCourse.mockRejectedValue(
      new ApiError(409, {
        error: 'action_conflict',
        conflict: { message: 'Category name "GLOBAL" is already used.' },
      })
    )

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    // Both halves dirty: the instructions, and the form (Model lives on
    // this same tab).
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'gpt-4o-mini' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // The instructions went through; the form did not.
    await waitFor(() => expect(saveCourseInstructions).toHaveBeenCalled())
    expect(
      await screen.findByText(/instructions were saved before this was refused/)
    ).toBeInTheDocument()

    // Discard the rest: the refusal goes, and so must the notice about it.
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() =>
      expect(
        screen.queryByText(/instructions were saved before this was refused/)
      ).not.toBeInTheDocument()
    )
  })

  // Round 2, finding 5: a tab click while the *instructions section's own*
  // Save is in flight used to open the prompt, run into that section's own
  // in-flight guard, and close having done and said nothing.
  it('does not open the prompt while the instructions section is already saving', async () => {
    getCourse.mockResolvedValue(COURSE)
    let release: (value: unknown) => void = () => {}
    saveCourseInstructions.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const onNavigateTab = vi.fn()

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onNavigateTab={onNavigateTab}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    // That section's own button, not the prompt's.
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
    await waitFor(() => expect(saveCourseInstructions).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(onNavigateTab).not.toHaveBeenCalled()
    expect(saveCourseInstructions).toHaveBeenCalledTimes(1)

    // Released so the pending save cannot leak into the next case. What
    // happens *after* it lands is deliberately not asserted here: whether
    // the next click prompts depends on `instructionsDirty` having
    // propagated through its own effect, which is a render-timing race
    // rather than behaviour — asserting it made this case fail roughly one
    // run in six. The clean-form path it would have covered is already its
    // own case ("switching tabs with nothing unsaved calls onNavigateTab
    // and asks nothing").
    release({ id: 'course-1', instructions: 'Cite the syllabus.' })
    await waitFor(() =>
      expect(screen.getByLabelText('Instructions')).toHaveValue('')
    )
  })

  // WEB-19: an unsaved *Instructions* edit is unsaved settings too, even
  // though that section keeps its own text and its own save — the prompt's
  // Save answer reaches it through the handles it registers
  // (`components/CourseInstructions.tsx`'s own `CourseInstructionsActions`).
  it('an unsaved Instructions edit is asked about too, and its own save is what Save changes runs', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourseInstructions.mockResolvedValue({ saved: true })
    const onNavigateTab = vi.fn()

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onNavigateTab={onNavigateTab}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))

    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(saveCourseInstructions).toHaveBeenCalledWith(
        'org-1',
        'course-1',
        'Cite the syllabus.'
      )
    )
    // The course form itself was clean, so it is not re-sent.
    expect(saveCourse).not.toHaveBeenCalled()
    await waitFor(() => expect(onNavigateTab).toHaveBeenCalledWith('discord'))
  })

  it('Discard changes throws an unsaved Instructions edit away too', async () => {
    getCourse.mockResolvedValue(COURSE)

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="ai"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByLabelText('Instructions')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Cite the syllabus.' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))

    await screen.findByRole('dialog', { name: 'Save your changes?' })
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Discord' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    expect(saveCourseInstructions).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    // The section is still mounted, so this is the discard itself, not a
    // remount fetching a blank list.
    await waitFor(() =>
      expect(screen.getByLabelText('Instructions')).toHaveValue('')
    )
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: the selector lives on the Discord tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    expect(screen.queryByLabelText('Discord server')).not.toBeInTheDocument()
  })

  it('offers a choice once the organization holds two or more active bindings, and saves the one chosen', async () => {
    listDiscordServers.mockResolvedValue([BINDING_A, BINDING_B])
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue({ ...COURSE, discordServerId: 'guild-b' })

    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: the selector lives on the Discord tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-43: the button is disabled on an unmodified form now — an edit
    // (irrelevant to what this case actually asserts) is what makes it
    // clickable at all.
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: the selector lives on the Discord tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: the selector lives on the Discord tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
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
        navigate={vi.fn()}
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
    // being answered through it. WEB-43: an edit is what makes the button
    // clickable at all, on an otherwise-unmodified form.
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: the notice and the read-only field are on the AI tab.
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: the AI tab is where either would show, if either showed.
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design')
    // WEB-43: an edit is what makes the button clickable at all.
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design II' },
    })
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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

  // WEB-40: the remove controls are icon-only now — findable by their
  // accessible name (unchanged, above), but with no visible "Remove
  // category"/"Remove channel" text sitting next to the icon.
  it('the category and channel remove controls are icon-only — no visible label text', async () => {
    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId={undefined}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }))

    const removeCategoryButton = screen.getByRole('button', {
      name: /Remove category/,
    })
    const removeChannelButton = screen.getByRole('button', {
      name: /Remove channel/,
    })
    expect(removeCategoryButton).toHaveTextContent('')
    expect(removeChannelButton).toHaveTextContent('')
  })

  // WEB-40: the channel-name input, the "Admins only" checkbox and the
  // delete control were already siblings under one row container before
  // this fix — jsdom has no layout engine, so it cannot tell a row that
  // wraps onto three lines from one that does not; the DOM shape here is
  // identical either way. The actual fix (`flex-1`/`min-w-0` making the
  // input give up the width `textInputClasses`'s own `w-full` used to
  // claim) is proven where layout actually exists — a real bounding-box
  // check in `e2e/course-configuration.spec.ts`, not here.
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: Instructions is on the AI tab.
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
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
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    await screen.findByDisplayValue('Web Design')

    // WEB-35: Instructions is on the AI tab.
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
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

/**
 * Rework round 1, must-fix 1 — `onConnectDiscord` (passed to
 * `ScaffoldButton`, below) used to call `navigate` directly, bypassing
 * this same unsaved-changes guard: every other way out of this editor
 * (`handleCancel`, `goToTabGuarded`) confirms first, but this one did not,
 * so a dirty edit on the very tab "Create Discord channels" lives on
 * vanished with no prompt the moment "Connect a server" was confirmed.
 */
describe('CourseEditor Discord scaffold "connect a server" guard (SRV-6/WEB-16)', () => {
  it('a dirty editor prompts before navigating to the Discord page, and cancelling the prompt stays put', async () => {
    getCourse.mockResolvedValue(COURSE)
    listDiscordServers.mockResolvedValue([])
    const navigate = vi.fn()

    renderWithModal(
      <CourseEditor
        navigate={navigate}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="discord"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design - GLOBAL')

    // Dirties the form from the Discord tab itself.
    fireEvent.change(screen.getByLabelText('Admins role'), {
      target: { value: 'new-admins-role' },
    })

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )
    const connectDialog = await screen.findByRole('dialog', {
      name: 'Connect a Discord server first',
    })
    fireEvent.click(
      within(connectDialog).getByRole('button', {
        name: 'Connect a server',
      })
    )

    // The unsaved-changes prompt, not a straight navigation.
    const discardDialog = await screen.findByRole('dialog', {
      name: 'Discard unsaved changes?',
    })
    expect(navigate).not.toHaveBeenCalled()

    fireEvent.click(
      within(discardDialog).getByRole('button', { name: 'Keep editing' })
    )
    await waitFor(() => expect(discardDialog).not.toBeVisible())
    expect(navigate).not.toHaveBeenCalled()
    // The edit is still there — "keep editing" discards nothing.
    expect(screen.getByLabelText('Admins role')).toHaveValue('new-admins-role')
  })

  it("confirming the discard prompt navigates to the organization's Discord page", async () => {
    getCourse.mockResolvedValue(COURSE)
    listDiscordServers.mockResolvedValue([])
    const navigate = vi.fn()

    renderWithModal(
      <CourseEditor
        navigate={navigate}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="discord"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design - GLOBAL')

    fireEvent.change(screen.getByLabelText('Admins role'), {
      target: { value: 'new-admins-role' },
    })

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )
    const connectDialog = await screen.findByRole('dialog', {
      name: 'Connect a Discord server first',
    })
    fireEvent.click(
      within(connectDialog).getByRole('button', {
        name: 'Connect a server',
      })
    )

    const discardDialog = await screen.findByRole('dialog', {
      name: 'Discard unsaved changes?',
    })
    fireEvent.click(
      within(discardDialog).getByRole('button', { name: 'Discard changes' })
    )

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        kind: 'discord',
        organizationId: 'org-1',
      })
    )
  })

  it('a clean editor navigates straight through, with no discard prompt', async () => {
    getCourse.mockResolvedValue(COURSE)
    listDiscordServers.mockResolvedValue([])
    const navigate = vi.fn()

    renderWithModal(
      <CourseEditor
        navigate={navigate}
        organizationId="org-1"
        project={PROJECT}
        courseId="course-1"
        tab="discord"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Web Design - GLOBAL')

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Discord channels' })
    )
    const connectDialog = await screen.findByRole('dialog', {
      name: 'Connect a Discord server first',
    })
    fireEvent.click(
      within(connectDialog).getByRole('button', {
        name: 'Connect a server',
      })
    )

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        kind: 'discord',
        organizationId: 'org-1',
      })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
