/**
 * ADMIN-1/ADMIN-3: `pages/Transcripts.tsx` — a course's transcript, read
 * back once a project and a course are chosen, and an export requested
 * and collected once ready.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Transcripts } from '../src/pages/Transcripts.js'

const {
  listProjects,
  listCourses,
  listTranscriptStudents,
  readTranscript,
  listTranscriptExports,
  exportTranscript,
  listTranscriptAccessLog,
} = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listCourses: vi.fn(),
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
  filePrefix: 'wd',
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

  render(<Transcripts organizationId="org-1" isOwner={isOwner} />)

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

    const studentSelect = await screen.findByLabelText('Student')
    expect(studentSelect).toHaveTextContent('Alice')
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

    render(<Transcripts organizationId="org-1" isOwner={false} />)
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

    render(<Transcripts organizationId="org-1" isOwner={false} />)
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

    render(<Transcripts organizationId="org-1" isOwner={false} />)
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

    render(<Transcripts organizationId="org-1" isOwner={false} />)
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

    render(<Transcripts organizationId="org-1" isOwner={false} />)
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
