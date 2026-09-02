/**
 * `components/CourseAttachments.tsx` (WEB-18, FILE-1..3): the screen a
 * course's knowledge files were missing entirely. Every case below is what
 * that component's own module comment promises: an upload, each file's own
 * pending/ready/failed status, a confirmed detach, and — the case this
 * project keeps hitting (`ScaffoldButton.tsx`'s own precedent) — a job
 * queued with no worker running to claim it read as "still queued," not a
 * silent hang.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseAttachmentSummary } from '../src/api/types.js'
import { CourseAttachments } from '../src/components/CourseAttachments.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { listCourseAttachments, attachCourseFile, detachCourseAttachment } =
  vi.hoisted(() => ({
    listCourseAttachments: vi.fn(),
    attachCourseFile: vi.fn(),
    detachCourseAttachment: vi.fn(),
  }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listCourseAttachments,
    attachCourseFile,
    detachCourseAttachment,
  }
})

function attachment(
  overrides: Partial<CourseAttachmentSummary> = {}
): CourseAttachmentSummary {
  return {
    id: 'att-1',
    filename: 'syllabus.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    status: 'pending',
    failureReason: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('CourseAttachments (WEB-18)', () => {
  it('shows the empty state when a course has no files attached', async () => {
    listCourseAttachments.mockResolvedValue([])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )

    expect(
      await screen.findByText('No files attached yet.')
    ).toBeInTheDocument()
  })

  it('lists each attachment with its own status', async () => {
    listCourseAttachments.mockResolvedValue([
      attachment({ id: 'att-1', filename: 'syllabus.pdf', status: 'ready' }),
      attachment({
        id: 'att-2',
        filename: 'schedule.pdf',
        status: 'failed',
        failureReason: 'unsupported file type',
      }),
      attachment({ id: 'att-3', filename: 'notes.pdf', status: 'pending' }),
    ])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )

    expect(await screen.findByText('syllabus.pdf')).toBeInTheDocument()
    expect(screen.getByText('Ready — grounding answers.')).toBeInTheDocument()
    expect(screen.getByText('schedule.pdf')).toBeInTheDocument()
    expect(screen.getByText('Failed.')).toBeInTheDocument()
    // FILE-2: the provider's own reason is visible next to the file that
    // failed — a course must never look configured while it is ungrounded.
    expect(screen.getByText('unsupported file type')).toBeInTheDocument()
    expect(screen.getByText('notes.pdf')).toBeInTheDocument()
    expect(screen.getByText('Pending…')).toBeInTheDocument()
  })

  // WEB-18: "an instructor never sees a vector store id" — this asserts it
  // structurally, not just that this test's own fixtures happen not to
  // carry one: even a list result shaped with extra provider bookkeeping
  // (as a careless future change to `courseAttachments.list`'s own
  // response might send) renders nothing beyond a file's name, size-scale
  // status and failure reason.
  it('never renders a vector store id or a provider file id, even if the API response carried one', async () => {
    listCourseAttachments.mockResolvedValue([
      {
        ...attachment({ status: 'ready' }),
        providerFileId: 'file_abc123',
        vectorStoreId: 'vs_do_not_show_me',
      },
    ])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )

    await screen.findByText('syllabus.pdf')
    expect(screen.queryByText(/file_abc123/)).not.toBeInTheDocument()
    expect(screen.queryByText(/vs_do_not_show_me/)).not.toBeInTheDocument()
  })

  it('uploads the selected file, base64-encoded, and refreshes the list', async () => {
    listCourseAttachments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([attachment({ status: 'pending' })])
    attachCourseFile.mockResolvedValue({
      attachmentId: 'att-1',
      jobId: 'job-1',
    })

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No files attached yet.')

    const file = new File(['%PDF-1.4 fixture'], 'syllabus.pdf', {
      type: 'application/pdf',
    })
    const input = screen.getByLabelText('Course file')
    fireEvent.change(input, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))

    await waitFor(() => expect(attachCourseFile).toHaveBeenCalledTimes(1))
    const [organizationId, courseId, uploadInput] = attachCourseFile.mock
      .calls[0] as [
      string,
      string,
      { filename: string; contentType: string; contentBase64: string },
    ]
    expect(organizationId).toBe('org-1')
    expect(courseId).toBe('course-1')
    expect(uploadInput.filename).toBe('syllabus.pdf')
    expect(uploadInput.contentType).toBe('application/pdf')
    // The exact base64 encoding of the fixture's own bytes — proves this is
    // a real encode of the selected file, not a stand-in string.
    expect(uploadInput.contentBase64).toBe(
      Buffer.from('%PDF-1.4 fixture').toString('base64')
    )

    expect(await screen.findByText('syllabus.pdf')).toBeInTheDocument()
    expect(listCourseAttachments).toHaveBeenCalledTimes(2)
  })

  it('a rejected upload shows the refusal and never adds a row', async () => {
    listCourseAttachments.mockResolvedValue([])
    attachCourseFile.mockRejectedValue(
      new ApiError(413, { error: 'invalid_request' })
    )

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No files attached yet.')

    const file = new File(['x'.repeat(10)], 'huge.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(screen.getByLabelText('Course file'), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Attach file' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('No files attached yet.')).toBeInTheDocument()
  })

  it('a pending attachment stuck past the hint threshold says the worker might not be running', async () => {
    listCourseAttachments.mockResolvedValue([attachment({ status: 'pending' })])

    renderWithModal(
      <CourseAttachments
        organizationId="org-1"
        courseId="course-1"
        pollIntervalMs={10}
        stillQueuedHintAfterMs={30}
      />
    )
    await screen.findByText('Pending…')

    expect(
      screen.queryByText(/make sure the background worker/)
    ).not.toBeInTheDocument()

    await waitFor(() =>
      expect(
        screen.getByText(/make sure the background worker/)
      ).toBeInTheDocument()
    )
  })

  it('a pending attachment that becomes ready before the hint threshold never shows it', async () => {
    listCourseAttachments
      .mockResolvedValueOnce([attachment({ status: 'pending' })])
      .mockResolvedValue([attachment({ status: 'ready' })])

    renderWithModal(
      <CourseAttachments
        organizationId="org-1"
        courseId="course-1"
        pollIntervalMs={10}
        stillQueuedHintAfterMs={200}
      />
    )
    await screen.findByText('Pending…')
    await screen.findByText('Ready — grounding answers.')

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(
      screen.queryByText(/make sure the background worker/)
    ).not.toBeInTheDocument()
  })

  it('detach confirms first — cancelling leaves the file exactly as it was', async () => {
    listCourseAttachments.mockResolvedValue([
      attachment({ status: 'ready', filename: 'syllabus.pdf' }),
    ])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('syllabus.pdf')

    fireEvent.click(screen.getByRole('button', { name: 'Detach syllabus.pdf' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Detach "syllabus.pdf"?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(detachCourseAttachment).not.toHaveBeenCalled()
    expect(screen.getByText('syllabus.pdf')).toBeInTheDocument()
    expect(screen.getByText('Ready — grounding answers.')).toBeInTheDocument()
  })

  it('detach, confirmed, dispatches the action and the row disappears once the poll reflects it gone', async () => {
    listCourseAttachments
      .mockResolvedValueOnce([
        attachment({ status: 'ready', filename: 'syllabus.pdf' }),
      ])
      .mockResolvedValue([])
    detachCourseAttachment.mockResolvedValue({ jobId: 'job-2' })

    renderWithModal(
      <CourseAttachments
        organizationId="org-1"
        courseId="course-1"
        pollIntervalMs={10}
      />
    )
    await screen.findByText('syllabus.pdf')

    fireEvent.click(screen.getByRole('button', { name: 'Detach syllabus.pdf' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Detach "syllabus.pdf"?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Detach' }))

    await waitFor(() =>
      expect(detachCourseAttachment).toHaveBeenCalledWith('org-1', 'att-1')
    )
    await waitFor(() =>
      expect(screen.queryByText('syllabus.pdf')).not.toBeInTheDocument()
    )
    expect(
      await screen.findByText('No files attached yet.')
    ).toBeInTheDocument()
  })

  it('a detach stuck past the hint threshold (still present) also says the worker might not be running', async () => {
    listCourseAttachments.mockResolvedValue([
      attachment({ status: 'ready', filename: 'syllabus.pdf' }),
    ])
    detachCourseAttachment.mockResolvedValue({ jobId: 'job-2' })

    renderWithModal(
      <CourseAttachments
        organizationId="org-1"
        courseId="course-1"
        pollIntervalMs={10}
        stillQueuedHintAfterMs={30}
      />
    )
    await screen.findByText('syllabus.pdf')

    fireEvent.click(screen.getByRole('button', { name: 'Detach syllabus.pdf' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Detach "syllabus.pdf"?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Detach' }))
    await screen.findByText('Removing…')

    await waitFor(() =>
      expect(
        screen.getByText(/make sure the background worker/)
      ).toBeInTheDocument()
    )
    // Still there — the row itself never disappears in this scenario
    // (`listCourseAttachments` keeps returning it), which is exactly the
    // "distinguishable from a hang" case this component exists for.
    expect(screen.getByText('syllabus.pdf')).toBeInTheDocument()
  })
})
