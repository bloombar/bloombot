/**
 * ADMIN-1/ADMIN-3: `pages/Transcripts.tsx` — a course's transcript, read
 * back once a project and a course are chosen, and an export requested
 * and collected once ready.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { Transcripts } from '../src/pages/Transcripts.js'

const {
  listProjects,
  listCourses,
  getCourse,
  listTranscriptStudents,
  readTranscript,
  listTranscriptExports,
  exportTranscript,
  listTranscriptAccessLog,
} = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listCourses: vi.fn(),
  getCourse: vi.fn(),
  listTranscriptStudents: vi.fn(),
  readTranscript: vi.fn(),
  listTranscriptExports: vi.fn(),
  exportTranscript: vi.fn(),
  listTranscriptAccessLog: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listProjects,
    listCourses,
    getCourse,
    listTranscriptStudents,
    readTranscript,
    listTranscriptExports,
    exportTranscript,
    listTranscriptAccessLog,
  }
})

afterEach(() => {
  vi.resetAllMocks()
})

const PROJECT = {
  id: 'proj-1',
  organizationId: 'org-1',
  name: 'Fall 2026',
  archivedAt: null,
  createdAt: 0,
}
const COURSE = {
  id: 'course-1',
  organizationId: 'org-1',
  projectId: 'proj-1',
  title: 'Web Design',
  enabled: true,
  adminsRole: 'a',
  studentsRole: 's',
  promptId: null,
  instructions: null,
  model: null,
  vectorStoreId: null,
  maxRequestsPerDay: null,
  conversationScope: 'course' as const,
  createdAt: 0,
}
// WEB-36 rework round 1 — a second course in the *same* project as
// `COURSE`, and a wholly separate project: must-fix 1's own two repros
// (Back to a same-project course, and a project genuinely different from
// whichever one is active) need a course/project this screen has not
// already loaded to be a real change.
const SECOND_COURSE = {
  ...COURSE,
  id: 'course-2',
  title: 'Data Structures',
}
const SECOND_PROJECT = {
  id: 'proj-2',
  organizationId: 'org-1',
  name: 'Spring 2027',
  archivedAt: null,
  createdAt: 0,
}

async function selectProjectAndCourse(
  isOwner = false,
  // ADMIN-2's own rows, when a caller wants specific ones (the `describe`
  // block below) — every other caller gets the same empty default every
  // other list here already takes.
  accessLogEntries: unknown[] = []
) {
  listProjects.mockResolvedValue([PROJECT])
  listCourses.mockResolvedValue([COURSE])
  listTranscriptStudents.mockResolvedValue([
    { personId: 'person-1', personDisplayName: 'Alice' },
  ])
  listTranscriptExports.mockResolvedValue([])
  listTranscriptAccessLog.mockResolvedValue(accessLogEntries)
  readTranscript.mockResolvedValue({
    courseId: COURSE.id,
    courseTitle: COURSE.title,
    entries: [
      {
        personId: 'person-1',
        personDisplayName: 'Alice',
        direction: 'from_person',
        content: 'What is the deadline?',
        createdAt: Date.now(),
      },
    ],
  })

  render(
    <Transcripts organizationId="org-1" isOwner={isOwner} navigate={vi.fn()} />
  )

  const projectSelect = await screen.findByLabelText('Project')
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.change(projectSelect, { target: { value: PROJECT.id } })
  const courseSelect = await screen.findByLabelText('Course')
  fireEvent.change(courseSelect, { target: { value: COURSE.id } })
}

describe('Transcripts (ADMIN-1)', () => {
  it('reads a course transcript once a project and course are chosen', async () => {
    await selectProjectAndCourse()

    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {})
    )
    expect(await screen.findByText('What is the deadline?')).toBeInTheDocument()
  })

  it('offers the student filter, populated from transcripts.listStudents', async () => {
    await selectProjectAndCourse()

    // `findByLabelText` only guarantees the `<select>` itself exists (it
    // renders unconditionally, with just "Every student," the instant a
    // course is chosen) — not that `listTranscriptStudents` has resolved
    // and populated its options yet, so asserting on its text content
    // right after racing that under load. `waitFor` keeps retrying the
    // whole assertion until the option actually lands.
    await waitFor(() =>
      expect(screen.getByLabelText('Student')).toHaveTextContent('Alice')
    )
  })

  // ADMIN-1..5 rework's fourth round, must-fix 1's other half — the file
  // itself says `identityFieldsOmitted`/`notice` now (`apps/worker/src/
  // handlers/transcripts.ts`'s own test coverage), but this screen is
  // where an instructor decides to click Export at all, and nothing there
  // said the same thing before this fix; `return {}` for `currentFilters`
  // (must-fix 5 above) would not have caught its absence either, since it
  // is unconditional text, not a filter.
  it('warns, next to Export, that an unfiltered export carries every student under a pseudonym and unfiltered message text', async () => {
    await selectProjectAndCourse()

    expect(
      await screen.findByText(/replaced with a pseudonym/i)
    ).toBeInTheDocument()

    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(await screen.findByLabelText('Student'), {
      target: { value: 'person-1' },
    })

    // A student-filtered export names its one student by construction —
    // the warning is specific to the unfiltered case, and disappears once
    // a student is chosen.
    expect(screen.queryByText(/replaced with a pseudonym/i)).toBeNull()
  })

  // Must-fix 5 of the ADMIN-1..5 rework — the filters are genuinely
  // server-side SQL (right), but were entirely unguarded by a test:
  // replacing this screen's own filter-gathering with `return {}` (every
  // field decorative) left every other test in this file green. Student
  // speech is the subject; this is the one test that actually presses
  // "Apply filters" with a student and a date range chosen, and reads back
  // what `readTranscript` was actually called with.
  it('applies the student and date filters, calling readTranscript with exactly what was chosen', async () => {
    await selectProjectAndCourse()
    readTranscript.mockClear()
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(await screen.findByLabelText('Student'), {
      target: { value: 'person-1' },
    })
    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2026-01-05' },
    })
    fireEvent.change(screen.getByLabelText('To date'), {
      target: { value: '2026-01-10' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    const expectedStartAt = Date.parse('2026-01-05T00:00:00')
    const expectedEndAt = Date.parse('2026-01-10T23:59:59.999')
    await waitFor(() =>
      expect(readTranscript).toHaveBeenLastCalledWith('org-1', COURSE.id, {
        personId: 'person-1',
        startAt: expectedStartAt,
        endAt: expectedEndAt,
      })
    )
  })

  it('shows an empty state when nothing matches the filters', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptExports.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })

    expect(
      await screen.findByText('No messages match these filters.')
    ).toBeInTheDocument()
  })

  it('requests an export (ADMIN-3)', async () => {
    await selectProjectAndCourse()
    exportTranscript.mockResolvedValue({ exportId: 'export-1', jobId: 'job-1' })
    listTranscriptExports.mockResolvedValue([
      {
        id: 'export-1',
        courseId: COURSE.id,
        personId: null,
        status: 'pending',
        filename: null,
        contentType: null,
        sizeBytes: null,
        failureReason: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])

    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }))

    await waitFor(() =>
      expect(exportTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {})
    )
  })

  it('shows a Download link once an export is ready', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })
    listTranscriptExports.mockResolvedValue([
      {
        id: 'export-1',
        courseId: COURSE.id,
        personId: null,
        status: 'ready',
        filename: 'transcript-export-export-1.json',
        contentType: 'application/json',
        sizeBytes: 42,
        failureReason: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })

    const link = await screen.findByRole('link', { name: /download/i })
    expect(link).toHaveAttribute(
      'href',
      '/organizations/org-1/transcript-exports/export-1/download'
    )
  })

  // Also-fix of the ADMIN-1..5 rework: a bare clock and a timestamp read
  // identically for every non-`ready` status — a stuck `pending` export
  // was indistinguishable from one still legitimately queued.
  it('labels a pending export "Queued…", not just a bare icon and a date', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })
    listTranscriptExports.mockResolvedValue([
      {
        id: 'export-1',
        courseId: COURSE.id,
        personId: null,
        status: 'pending',
        filename: null,
        contentType: null,
        sizeBytes: null,
        failureReason: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })

    expect(await screen.findByText(/Queued…/)).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /download/i })
    ).not.toBeInTheDocument()
  })

  it('labels a failed export "Failed" and shows its own reason', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })
    listTranscriptExports.mockResolvedValue([
      {
        id: 'export-1',
        courseId: COURSE.id,
        personId: null,
        status: 'failed',
        filename: null,
        contentType: null,
        sizeBytes: null,
        failureReason: 'gave up after 5 attempt(s): disk full',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })

    expect(await screen.findByText(/^Failed —/)).toBeInTheDocument()
    expect(
      screen.getByText('gave up after 5 attempt(s): disk full')
    ).toBeInTheDocument()
  })

  it('shows a "still queued" hint naming the worker once a pending export has waited past the threshold', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })
    listTranscriptExports.mockResolvedValue([
      {
        id: 'export-1',
        courseId: COURSE.id,
        personId: null,
        status: 'pending',
        filename: null,
        contentType: null,
        sizeBytes: null,
        failureReason: null,
        // Old enough, relative to `Date.now()` at render time, that this
        // screen's own `STILL_QUEUED_HINT_AFTER_MS` threshold has already
        // passed — this test does not need fake timers or a real wait,
        // since the threshold is compared against the export's own
        // server-set `createdAt`, not client-side polling state.
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      },
    ])

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })

    expect(await screen.findByText(/still queued/i)).toBeInTheDocument()
    expect(screen.getByText('npm run worker:dev')).toBeInTheDocument()
  })
})

describe('Transcripts — Access log (ADMIN-2)', () => {
  it('an owner sees the access log, naming who read what and when', async () => {
    await selectProjectAndCourse(true, [
      {
        id: 'log-2',
        actorAccountId: 'account-1',
        actorDisplayName: 'Owner Person',
        personId: 'person-1',
        personDisplayName: 'Alice',
        kind: 'read',
        startAt: null,
        endAt: null,
        createdAt: Date.now(),
      },
      {
        id: 'log-1',
        actorAccountId: 'account-1',
        actorDisplayName: 'Owner Person',
        personId: null,
        personDisplayName: null,
        kind: 'read',
        startAt: null,
        endAt: null,
        createdAt: Date.now() - 1000,
      },
    ])

    expect(
      await screen.findByRole('heading', { name: 'Access log' })
    ).toBeInTheDocument()
    expect(screen.getByText('Owner Person read Alice')).toBeInTheDocument()
    // An unfiltered read names nobody in particular.
    expect(
      screen.getByText('Owner Person read the whole course')
    ).toBeInTheDocument()
    expect(listTranscriptAccessLog).toHaveBeenCalledWith('org-1', COURSE.id)
  })

  // ADMIN-2's own restriction: `transcripts.listAccessLog` refuses anyone
  // but an owner — this screen withholds the section (and the request)
  // rather than rendering a control every click through which would
  // refuse, the same discipline `pages/Usage.tsx`'s own `isOwner` gate
  // already takes.
  it('withholds the Access log section entirely for a non-owner, and never requests it', async () => {
    await selectProjectAndCourse(false)

    await screen.findByRole('heading', { name: 'Transcripts' })
    expect(
      screen.queryByRole('heading', { name: 'Access log' })
    ).not.toBeInTheDocument()
    expect(listTranscriptAccessLog).not.toHaveBeenCalled()
  })
})

// WEB-36: a transcript link (`components/CoursePeople.tsx`) opens this
// screen with a course, and a person, already chosen and read — this
// screen has no project id of its own in the address, so it is resolved
// from the course via `getCourse`.
describe('Transcripts — opened from a route-named course/person (WEB-36)', () => {
  it('resolves the project from the route’s own course, selects both, and reads the transcript once — filtered to the named person', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    getCourse.mockResolvedValue({ ...COURSE, categories: [] })
    listTranscriptStudents.mockResolvedValue([
      { personId: 'person-1', personDisplayName: 'Alice' },
    ])
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [
        {
          personId: 'person-1',
          personDisplayName: 'Alice',
          direction: 'from_person',
          content: 'What is the deadline?',
          createdAt: Date.now(),
        },
      ],
    })

    render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        personId="person-1"
        navigate={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Project')).toHaveValue(PROJECT.id)
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Course')).toHaveValue(COURSE.id)
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Student')).toHaveValue('person-1')
    )
    expect(await screen.findByText('What is the deadline?')).toBeInTheDocument()
    // Exactly one read — never an unfiltered whole-course read followed by
    // a filtered one once state caught up (this screen's own module
    // comment on why the ordinary apply-on-courseId-change effect stands
    // aside here).
    expect(readTranscript).toHaveBeenCalledTimes(1)
    expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {
      personId: 'person-1',
    })
  })

  it('resolves and reads a route-named course with no person named at all', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    getCourse.mockResolvedValue({ ...COURSE, categories: [] })
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        navigate={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {})
    )
    expect(readTranscript).toHaveBeenCalledTimes(1)
  })

  // A person linked from a disabled course must still resolve — this
  // screen's course picker is otherwise limited to enabled courses only
  // (ADMIN-1's own choice), so the seeded course is the one exception,
  // added to the list rather than the picker landing empty.
  it('a route-named disabled course still resolves and shows selected, despite the enabled-only course picker', async () => {
    const disabledCourse = { ...COURSE, enabled: false }
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([disabledCourse])
    getCourse.mockResolvedValue({ ...disabledCourse, categories: [] })
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        navigate={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Course')).toHaveValue(COURSE.id)
    )
    // Rework round 1, cheap fix — a disabled course in this otherwise
    // enabled-only picker is marked, rather than sorting last with no sign
    // why it differs (`pages/Transcripts.tsx`'s own module comment).
    expect(
      screen.getByRole('option', { name: `${COURSE.title} — disabled` })
    ).toBeInTheDocument()
  })

  // Handled honestly (this screen's own module comment): a course id in
  // the address this account cannot read renders the same `ErrorMessage`
  // every other refusal on this screen already does, not a silently empty
  // screen.
  it('a route-named course this account cannot read renders the same ErrorMessage as any other refusal', async () => {
    listProjects.mockResolvedValue([PROJECT])
    getCourse.mockRejectedValue(new ApiError(404, { error: 'action_refused' }))

    render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId="course-missing"
        navigate={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  it('picking a different course pushes the address that names it', async () => {
    const navigate = vi.fn()
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptExports.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={navigate} />
    )
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })

    expect(navigate).toHaveBeenCalledWith({
      kind: 'transcripts',
      organizationId: 'org-1',
      courseId: COURSE.id,
    })
  })

  it('picking a student pushes the address naming that student', async () => {
    const navigate = vi.fn()
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([
      { personId: 'person-1', personDisplayName: 'Alice' },
    ])
    listTranscriptExports.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={navigate} />
    )
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })
    navigate.mockClear()
    // The Student select's own options populate asynchronously
    // (`listTranscriptStudents`) — waiting for the label alone (as above)
    // is not enough to guarantee jsdom actually has an `option
    // value="person-1"` to select yet; firing the change before it does
    // silently sets the value back to '' instead.
    await screen.findByRole('option', { name: 'Alice' })
    fireEvent.change(screen.getByLabelText('Student'), {
      target: { value: 'person-1' },
    })

    expect(navigate).toHaveBeenCalledWith({
      kind: 'transcripts',
      organizationId: 'org-1',
      courseId: COURSE.id,
      personId: 'person-1',
    })
  })

  it('changing the project while a course is selected navigates back to the bare landing address, and actually clears the course', async () => {
    const navigate = vi.fn()
    // Must-fix 5 — the first draft of this test re-selected the *same*
    // project (a no-op `<select>` change in a real browser, since the
    // value did not change) and never asserted `courseId` itself cleared,
    // so it stayed green even when this screen forgot to clear it. A
    // genuinely different project, with `courseId`'s own value checked
    // after.
    listProjects.mockResolvedValue([PROJECT, SECOND_PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptExports.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={navigate} />
    )
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })
    navigate.mockClear()

    fireEvent.change(screen.getByLabelText('Project'), {
      target: { value: SECOND_PROJECT.id },
    })

    expect(navigate).toHaveBeenCalledWith({
      kind: 'transcripts',
      organizationId: 'org-1',
    })
    expect(screen.getByLabelText('Course')).toHaveValue('')
  })
})

// WEB-36 rework round 1, must-fix 1 — this screen must honour a route
// change on *every* prop change, not only the first one it ever sees: a
// person added or swapped with the course unchanged, a different course in
// the *same* project (the actual defect: `setProjectId` is a no-op there,
// so nothing about a state *diff* can ever catch this case), and the route
// losing its course entirely (the drawer's own bare landing address).
describe('Transcripts — route changes while mounted (WEB-36 rework round 1, must-fix 1)', () => {
  it('a routePersonId change alone, the course unchanged, seeds the new person and reads again', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    getCourse.mockResolvedValue({ ...COURSE, categories: [] })
    listTranscriptStudents.mockResolvedValue([
      { personId: 'person-1', personDisplayName: 'Alice' },
      { personId: 'person-2', personDisplayName: 'Bob' },
    ])
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])
    readTranscript.mockImplementation((_org, _course, filters) =>
      Promise.resolve({
        courseId: COURSE.id,
        courseTitle: COURSE.title,
        entries: [
          {
            personId: filters.personId ?? 'nobody',
            personDisplayName:
              filters.personId === 'person-2' ? 'Bob' : 'Alice',
            direction: 'from_person' as const,
            content:
              filters.personId === 'person-2'
                ? "Bob's message"
                : "Alice's message",
            createdAt: Date.now(),
          },
        ],
      })
    )

    const { rerender } = render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        personId="person-1"
        navigate={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Student')).toHaveValue('person-1')
    )
    expect(await screen.findByText("Alice's message")).toBeInTheDocument()

    rerender(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        personId="person-2"
        navigate={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Student')).toHaveValue('person-2')
    )
    expect(await screen.findByText("Bob's message")).toBeInTheDocument()
    expect(readTranscript).toHaveBeenLastCalledWith('org-1', COURSE.id, {
      personId: 'person-2',
    })
  })

  it('a different course in the same project (the setProjectId no-op case) still seeds and reads the new course', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE, SECOND_COURSE])
    getCourse.mockImplementation((_org, courseId) =>
      Promise.resolve({
        ...(courseId === SECOND_COURSE.id ? SECOND_COURSE : COURSE),
        categories: [],
      })
    )
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])
    readTranscript.mockImplementation((_org, courseId) =>
      Promise.resolve({
        courseId,
        courseTitle:
          courseId === SECOND_COURSE.id ? SECOND_COURSE.title : COURSE.title,
        entries: [],
      })
    )

    const { rerender } = render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        navigate={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Course')).toHaveValue(COURSE.id)
    )
    await waitFor(() =>
      expect(readTranscript).toHaveBeenLastCalledWith('org-1', COURSE.id, {})
    )

    // Back to a previous, same-project course — the actual defect: nothing
    // about `projectId` itself changes here, so a fix that only reacts to
    // a `projectId` *diff* cannot ever catch this.
    rerender(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={SECOND_COURSE.id}
        navigate={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByLabelText('Course')).toHaveValue(SECOND_COURSE.id)
    )
    await waitFor(() =>
      expect(readTranscript).toHaveBeenLastCalledWith(
        'org-1',
        SECOND_COURSE.id,
        {}
      )
    )
  })

  it("the route losing its course (the drawer's own bare landing address) resets the screen", async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    getCourse.mockResolvedValue({ ...COURSE, categories: [] })
    listTranscriptStudents.mockResolvedValue([
      { personId: 'person-1', personDisplayName: 'Alice' },
    ])
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [
        {
          personId: 'person-1',
          personDisplayName: 'Alice',
          direction: 'from_person',
          content: 'What is the deadline?',
          createdAt: Date.now(),
        },
      ],
    })

    const { rerender } = render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        personId="person-1"
        navigate={vi.fn()}
      />
    )
    expect(await screen.findByText('What is the deadline?')).toBeInTheDocument()

    // The drawer's own Transcripts item pushes exactly this — no course, no
    // person.
    rerender(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )

    await waitFor(() => expect(screen.getByLabelText('Course')).toHaveValue(''))
    expect(screen.queryByText('What is the deadline?')).not.toBeInTheDocument()
    // The project is not part of the address (this screen's own module
    // comment on why) — left as is, not reset to blank.
    expect(screen.getByLabelText('Project')).toHaveValue(PROJECT.id)
  })
})

// WEB-36 rework round 1, must-fix 2 — a route-seeded course/person must not
// silently poison a later, unrelated pick once the seed's own async work is
// done: picking a *different* course through the ordinary select clears
// `personId` and reads the ordinary, unfiltered way, never inheriting the
// seed's own person.
describe('Transcripts — a seed does not poison a later ordinary pick (WEB-36 rework round 1, must-fix 2)', () => {
  it('seeding a course + person, then picking a different course through the select clears personId and reads unfiltered', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE, SECOND_COURSE])
    getCourse.mockResolvedValue({ ...COURSE, categories: [] })
    listTranscriptStudents.mockResolvedValue([
      { personId: 'person-1', personDisplayName: 'Alice' },
    ])
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        personId="person-1"
        navigate={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Student')).toHaveValue('person-1')
    )
    readTranscript.mockClear()

    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: SECOND_COURSE.id },
    })

    await waitFor(() =>
      expect(screen.getByLabelText('Student')).toHaveValue('')
    )
    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', SECOND_COURSE.id, {})
    )
    // Never the seed's own `person-1` carried over to the new course.
    expect(readTranscript).not.toHaveBeenCalledWith('org-1', SECOND_COURSE.id, {
      personId: 'person-1',
    })
  })

  // The reviewers' own reproduction: a failed seed used to strand the
  // "seeding" flag permanently `true` (the first draft's `seedingRef`, a
  // plain boolean never reset on this exact failure), after which *every*
  // later course pick silently took the seeded-read path — reading with
  // whatever stale `personId` the failed seed had recorded, and dropping
  // the date filters an ordinary "Apply filters" click would otherwise
  // send.
  it('a seed whose own listTranscriptStudents call fails does not strand a later pick on the seeded path', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE, SECOND_COURSE])
    getCourse.mockResolvedValue({ ...COURSE, categories: [] })
    // A base of `[]` for every call after the first — only the seed's own
    // (first) call actually fails.
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptStudents.mockRejectedValueOnce(
      new ApiError(500, { error: 'action_refused' })
    )
    listTranscriptExports.mockResolvedValue([])
    listTranscriptAccessLog.mockResolvedValue([])

    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    render(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        personId="person-1"
        navigate={vi.fn()}
      />
    )
    // The seed's own refusal surfaces the same way any other does.
    await screen.findByRole('alert')

    // A date filter set while still on the failed seed's own course — the
    // reviewers' own words: a stranded seed flag makes a *later* course
    // pick "silently drop the date filters," since the seeded-read branch
    // only ever sends `personId`, never a date range. Set here, before the
    // pick below, so the assertion can tell "went through the seeded
    // branch" (dates missing) apart from "went through the ordinary
    // `runSearch`/`currentFilters` path" (dates present).
    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2026-01-05' },
    })

    // A later, ordinary pick must not inherit whatever the failed seed left
    // behind.
    listTranscriptStudents.mockResolvedValue([])
    readTranscript.mockClear()
    readTranscript.mockResolvedValue({
      courseId: SECOND_COURSE.id,
      courseTitle: SECOND_COURSE.title,
      entries: [],
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: SECOND_COURSE.id },
    })

    const expectedStartAt = Date.parse('2026-01-05T00:00:00')
    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', SECOND_COURSE.id, {
        startAt: expectedStartAt,
      })
    )
  })
})

// WEB-36 rework round 1 (e2e finding: `e2e/transcript-access-log.spec.ts`
// caught this, the unit suite did not, since these props here are static —
// they never actually change in response to a `navigate` call the way a
// live route does). In the real app, every pick below feeds straight back
// down through `pages/Shell.tsx` as this component's own next
// `courseId`/`personId` props, since `navigate` really does update the
// address. Simulated here with `rerender`, passing back exactly the
// address the pick itself would produce, to prove the seeding effect does
// not mistake its own pick's echo for a genuinely new route and re-run the
// whole chain (and, worse, re-dispatch an ADMIN-2-audited `transcripts.read`)
// a second time.
describe('Transcripts — an ordinary pick’s own address echoing back down does not re-seed (WEB-36 rework round 1, e2e finding)', () => {
  it('picking a course, then receiving that same course back as props, does not re-run the seed or read again', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([])
    listTranscriptExports.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    const { rerender } = render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })
    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {})
    )
    readTranscript.mockClear()
    getCourse.mockClear()

    // The live app's own next render, once `navigate` has actually pushed
    // the address the pick above produced.
    rerender(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        navigate={vi.fn()}
      />
    )

    // Give any wrongly re-triggered seed a full microtask chain's worth of
    // time to (mis)fire before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getCourse).not.toHaveBeenCalled()
    expect(readTranscript).not.toHaveBeenCalled()
  })

  it('picking a student, then receiving that same student back as props, does not re-seed or read again', async () => {
    listProjects.mockResolvedValue([PROJECT])
    listCourses.mockResolvedValue([COURSE])
    listTranscriptStudents.mockResolvedValue([
      { personId: 'person-1', personDisplayName: 'Alice' },
    ])
    listTranscriptExports.mockResolvedValue([])
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })

    const { rerender } = render(
      <Transcripts organizationId="org-1" isOwner={false} navigate={vi.fn()} />
    )
    fireEvent.change(await screen.findByLabelText('Project'), {
      target: { value: PROJECT.id },
    })
    fireEvent.change(await screen.findByLabelText('Course'), {
      target: { value: COURSE.id },
    })
    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {})
    )
    await screen.findByRole('option', { name: 'Alice' })
    fireEvent.change(screen.getByLabelText('Student'), {
      target: { value: 'person-1' },
    })
    readTranscript.mockClear()
    getCourse.mockClear()

    rerender(
      <Transcripts
        organizationId="org-1"
        isOwner={false}
        courseId={COURSE.id}
        personId="person-1"
        navigate={vi.fn()}
      />
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getCourse).not.toHaveBeenCalled()
    expect(readTranscript).not.toHaveBeenCalled()
  })
})
