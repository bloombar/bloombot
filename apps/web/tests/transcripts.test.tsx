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
} = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listCourses: vi.fn(),
  listTranscriptStudents: vi.fn(),
  readTranscript: vi.fn(),
  listTranscriptExports: vi.fn(),
  exportTranscript: vi.fn(),
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

async function selectProjectAndCourse() {
  listProjects.mockResolvedValue([PROJECT])
  listCourses.mockResolvedValue([COURSE])
  listTranscriptStudents.mockResolvedValue([
    { personId: 'person-1', personDisplayName: 'Alice' },
  ])
  listTranscriptExports.mockResolvedValue([])
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

  render(<Transcripts organizationId="org-1" />)

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

    render(<Transcripts organizationId="org-1" />)
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

    render(<Transcripts organizationId="org-1" />)
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
})
