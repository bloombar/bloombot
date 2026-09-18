/**
 * WEB-63/WEB-64: `pages/CourseEditor.tsx`'s own Usage and Transcripts tabs
 * — a course's own usage, and its own transcripts, on the course's own
 * screen rather than only the organization-wide `pages/Usage.tsx`/
 * `pages/Transcripts.tsx`. Both tabs are real addresses
 * (`routing/route.ts#COURSE_EDITOR_TABS`), reachable the same way every
 * other tab this screen renders already is.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type {
  Course,
  OrganizationUsageReport,
  Project,
} from '../src/api/types.js'
import { CourseEditor } from '../src/pages/CourseEditor.js'
import { renderWithModal, withModal } from './helpers/render-with-modal.js'

const {
  getCourse,
  listDiscordServers,
  listCourseAttachments,
  listCourseInstructionRevisions,
  listCourseJoinLinks,
  listCourseWebSources,
  listCourseEnrolments,
  fetchOrganizationUsage,
  listTranscriptStudents,
  readTranscript,
  listTranscriptExports,
  listTranscriptAccessLog,
  exportTranscript,
} = vi.hoisted(() => ({
  getCourse: vi.fn(),
  listDiscordServers: vi.fn(),
  listCourseAttachments: vi.fn(),
  listCourseInstructionRevisions: vi.fn(),
  listCourseJoinLinks: vi.fn(),
  listCourseWebSources: vi.fn(),
  listCourseEnrolments: vi.fn(),
  fetchOrganizationUsage: vi.fn(),
  listTranscriptStudents: vi.fn(),
  readTranscript: vi.fn(),
  listTranscriptExports: vi.fn(),
  listTranscriptAccessLog: vi.fn(),
  exportTranscript: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    getCourse,
    listDiscordServers,
    listCourseAttachments,
    listCourseInstructionRevisions,
    listCourseJoinLinks,
    listCourseWebSources,
    listCourseEnrolments,
    fetchOrganizationUsage,
    listTranscriptStudents,
    readTranscript,
    listTranscriptExports,
    listTranscriptAccessLog,
    exportTranscript,
  }
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
  aiApprovedAt: 1000,
  categories: [],
}

// Review must-fix 2 — a second course, in the same project, for the
// Back/Forward regression below: switching *which* course this same
// `CourseEditor` instance edits (`pages/ProjectsPanel.tsx` renders it with
// no `key`) must never fire an audited read for the course being switched
// *to* before its own Transcripts tab is actually opened.
const COURSE_B: Course = { ...COURSE, id: 'course-2', title: 'Data Structures' }

function report(
  overrides: Partial<OrganizationUsageReport> = {}
): OrganizationUsageReport {
  return {
    organizationId: 'org-1',
    spendingCapMicros: null,
    totalCostMicros: 0,
    totalEstimatedCostMicros: 0,
    courses: [],
    studentsNearLimit: [],
    bySurface: [],
    ...overrides,
  }
}

beforeEach(() => {
  getCourse.mockResolvedValue(COURSE)
  listDiscordServers.mockResolvedValue([])
  listCourseAttachments.mockResolvedValue([])
  listCourseInstructionRevisions.mockResolvedValue([])
  listCourseJoinLinks.mockResolvedValue([])
  listCourseWebSources.mockResolvedValue([])
  listCourseEnrolments.mockResolvedValue([])
  listTranscriptStudents.mockResolvedValue([])
  listTranscriptExports.mockResolvedValue([])
  listTranscriptAccessLog.mockResolvedValue([])
  readTranscript.mockResolvedValue({
    courseId: COURSE.id,
    courseTitle: COURSE.title,
    entries: [],
  })
})

afterEach(() => {
  vi.resetAllMocks()
})

function renderEditor(tab: 'usage' | 'transcripts', isOwner = false) {
  return renderWithModal(
    <CourseEditor
      navigate={vi.fn()}
      organizationId="org-1"
      project={PROJECT}
      courseId={COURSE.id}
      tab={tab}
      isOwner={isOwner}
      onSaved={vi.fn()}
      onOpenChat={vi.fn()}
      onCancel={vi.fn()}
    />
  )
}

describe('CourseEditor — Usage tab (WEB-63)', () => {
  it('shows this course’s own figures and its near-limit students, from the same organization-wide read pages/Usage.tsx uses', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({
        courses: [
          {
            courseId: COURSE.id,
            courseTitle: COURSE.title,
            costMicros: 1_500_000,
            estimatedCostMicros: 0,
            callCount: 3,
            bySurface: [],
          },
          // A second course in the same organization — proof this tab
          // filters down to `courseId`, not the organization's whole list.
          {
            courseId: 'course-2',
            courseTitle: 'Another Course',
            costMicros: 9_000_000,
            estimatedCostMicros: 0,
            callCount: 9,
            bySurface: [],
          },
        ],
        studentsNearLimit: [
          {
            courseId: COURSE.id,
            courseTitle: COURSE.title,
            personId: 'person-1',
            personDisplayName: 'Alice',
            count: 8,
            maxRequestsPerDay: 10,
          },
          {
            courseId: 'course-2',
            courseTitle: 'Another Course',
            personId: 'person-2',
            personDisplayName: 'Bob',
            count: 9,
            maxRequestsPerDay: 10,
          },
        ],
      })
    )

    renderEditor('usage')

    expect(await screen.findByText(/\$1\.50 · 3 calls/)).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('8 of 10 today')).toBeInTheDocument()
    // Never the other course's own figures or students.
    expect(screen.queryByText(/\$9\.00/)).not.toBeInTheDocument()
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
    expect(screen.queryByText('Another Course')).not.toBeInTheDocument()
  })

  it('never shows the organization’s own spending-cap form — that is pages/Usage.tsx’s own, owner-only control', async () => {
    fetchOrganizationUsage.mockResolvedValue(
      report({ spendingCapMicros: 5_000_000 })
    )

    renderEditor('usage', true)

    await waitFor(() => expect(fetchOrganizationUsage).toHaveBeenCalled())
    expect(screen.queryByLabelText('Spending cap ($)')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Save cap' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Cap set at/)).not.toBeInTheDocument()
  })

  it('a failed load renders the same ErrorMessage every other refusal in this app uses', async () => {
    fetchOrganizationUsage.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )

    renderEditor('usage')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.'
    )
  })
})

describe('CourseEditor — Transcripts tab (WEB-64)', () => {
  it('offers no project or course selector — the course is already chosen', async () => {
    renderEditor('transcripts')

    await screen.findByLabelText('Student')
    expect(
      screen.queryByRole('combobox', { name: 'Project' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: 'Course' })
    ).not.toBeInTheDocument()
  })

  // Cheap-fix 3 (coordinator review) — this test's own title always named
  // both filters, but only the student one was ever exercised;
  // `TranscriptBrowser`'s own uncontrolled date fallback (only ever
  // reached from this tab — `pages/Transcripts.tsx` controls the dates
  // itself, this file's own module comment) otherwise has no coverage at
  // all.
  it('reads this course’s transcript on its own, filters by student and date, and exports — the same actions pages/Transcripts.tsx dispatches', async () => {
    listTranscriptStudents.mockResolvedValue([
      { personId: 'person-1', personDisplayName: 'Alice' },
    ])
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

    renderEditor('transcripts')

    expect(await screen.findByText('What is the deadline?')).toBeInTheDocument()
    expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {})

    readTranscript.mockClear()
    readTranscript.mockResolvedValue({
      courseId: COURSE.id,
      courseTitle: COURSE.title,
      entries: [],
    })
    await screen.findByRole('option', { name: 'Alice' })
    fireEvent.change(screen.getByLabelText('Student'), {
      target: { value: 'person-1' },
    })
    fireEvent.change(screen.getByLabelText('From date'), {
      target: { value: '2026-01-05' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    const expectedStartAt = Date.parse('2026-01-05T00:00:00')
    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {
        personId: 'person-1',
        startAt: expectedStartAt,
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() =>
      expect(exportTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {
        personId: 'person-1',
        startAt: expectedStartAt,
      })
    )
  })

  it('ADMIN-2: reading this tab’s transcript records the same access-log entry pages/Transcripts.tsx’s own read does, visible to an owner', async () => {
    listTranscriptAccessLog.mockResolvedValue([
      {
        id: 'log-1',
        actorAccountId: 'account-1',
        actorDisplayName: 'Owner Person',
        personId: null,
        personDisplayName: null,
        kind: 'read',
        startAt: null,
        endAt: null,
        createdAt: Date.now(),
      },
    ])

    renderEditor('transcripts', true)

    expect(
      await screen.findByText('Owner Person read the whole course')
    ).toBeInTheDocument()
    expect(listTranscriptAccessLog).toHaveBeenCalledWith('org-1', COURSE.id)
  })

  it('withholds the Access log section for a non-owner', async () => {
    renderEditor('transcripts', false)

    await screen.findByLabelText('Student')
    expect(
      screen.queryByRole('heading', { name: 'Access log' })
    ).not.toBeInTheDocument()
    expect(listTranscriptAccessLog).not.toHaveBeenCalled()
  })
})

describe('CourseEditor — Usage/Transcripts tabs are real addresses (WEB-33/WEB-34)', () => {
  it('both tabs appear in the tab bar, alongside the five WEB-35 tabs', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())
    renderEditor('usage')

    await screen.findByRole('tab', { name: 'General' })
    for (const name of [
      'General',
      'AI',
      'Discord',
      'Roster',
      'People',
      'Usage',
      'Transcripts',
    ]) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
  })

  it('a click on the Usage or Transcripts tab pushes that tab’s own address, the same as every other tab', async () => {
    fetchOrganizationUsage.mockResolvedValue(report())
    const onNavigateTab = vi.fn()
    renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId={COURSE.id}
        tab="general"
        onNavigateTab={onNavigateTab}
        onSaved={vi.fn()}
        onOpenChat={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await screen.findByRole('tab', { name: 'General' })

    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    expect(onNavigateTab).toHaveBeenCalledWith('usage')

    fireEvent.click(screen.getByRole('tab', { name: 'Transcripts' }))
    expect(onNavigateTab).toHaveBeenCalledWith('transcripts')
  })
})

// Review must-fix 2 — `visitedTabs` used to reset inside the
// `[organizationId, courseId]` data-loading effect, which commits *after*
// children have already rendered against the outgoing course's stale
// `visitedTabs`. Reachable by Back/Forward between two course-editor
// routes (`pages/ProjectsPanel.tsx` renders this component with no `key`,
// this file's own module comment on `resetForCourseIdRef`): sitting on one
// course's Transcripts tab, then switching to a different course, used to
// mount that course's own `TranscriptBrowser` — and fire its own
// ADMIN-2-audited read — before the reset had a chance to run.
describe('CourseEditor — a course switch never audits a Transcripts tab nobody opened for the new course (review must-fix 2)', () => {
  it('switching from course A’s Transcripts tab to course B’s General tab issues no read for course B', async () => {
    getCourse.mockImplementation((_organizationId: string, courseId: string) =>
      Promise.resolve(courseId === COURSE_B.id ? COURSE_B : COURSE)
    )
    readTranscript.mockImplementation(
      (_organizationId: string, courseId: string) =>
        Promise.resolve({ courseId, courseTitle: 'x', entries: [] })
    )

    const { rerender } = renderWithModal(
      <CourseEditor
        navigate={vi.fn()}
        organizationId="org-1"
        project={PROJECT}
        courseId={COURSE.id}
        tab="transcripts"
        onSaved={vi.fn()}
        onOpenChat={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(readTranscript).toHaveBeenCalledWith('org-1', COURSE.id, {})
    )
    readTranscript.mockClear()

    // The same Back/Forward move `pages/ProjectsPanel.tsx` produces: a new
    // `courseId`, landing on that course's own General tab.
    rerender(
      withModal(
        <CourseEditor
          navigate={vi.fn()}
          organizationId="org-1"
          project={PROJECT}
          courseId={COURSE_B.id}
          tab="general"
          onSaved={vi.fn()}
          onOpenChat={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    )

    await screen.findByDisplayValue(COURSE_B.title)
    // A moment for any wrongly re-triggered mount to (mis)fire before
    // asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readTranscript).not.toHaveBeenCalled()
  })
})
