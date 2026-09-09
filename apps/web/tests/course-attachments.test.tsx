/**
 * `components/CourseAttachments.tsx` (WEB-18, FILE-1..3, FILE-7): the screen
 * a course's knowledge files were missing entirely. Every case below is
 * what that component's own module comment promises: queuing and uploading
 * several files in one pass, each file's own pending/ready/failed status, a
 * one-click detach with no confirmation, and — the case this project keeps
 * hitting (`ScaffoldButton.tsx`'s own precedent) — a job queued with no
 * worker running to claim it read as "still queued," not a silent hang.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'
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

/**
 * Choose one or several files the way a person does — dropping them on the
 * zone. The label names the zone (a real button, so the keyboard can reach
 * it), not the hidden picker behind it, so `fireEvent.change` on the
 * label's target no longer selects anything.
 */
function chooseFiles(files: File[]): void {
  fireEvent.drop(screen.getByRole('button', { name: /Course files/ }), {
    dataTransfer: { files, types: ['Files'] },
  })
}

describe('CourseAttachments (WEB-18, FILE-7)', () => {
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

  // FILE-7: choosing several files at once queues all of them, and the
  // button's own label counts them.
  it('choosing several files queues them all', async () => {
    listCourseAttachments.mockResolvedValue([])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No files attached yet.')

    chooseFiles([
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ])

    expect(
      await screen.findByText('a.pdf', { exact: false })
    ).toBeInTheDocument()
    expect(screen.getByText('b.pdf', { exact: false })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Attach 2 files' })
    ).toBeInTheDocument()
  })

  // FILE-7: a second choose appends to the queue rather than replacing it —
  // an instructor picking readings in two passes is the normal case.
  it('a second choose appends to the queue', async () => {
    listCourseAttachments.mockResolvedValue([])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No files attached yet.')

    chooseFiles([new File(['a'], 'a.pdf', { type: 'application/pdf' })])
    expect(
      await screen.findByRole('button', { name: 'Attach 1 file' })
    ).toBeInTheDocument()

    chooseFiles([new File(['b'], 'b.pdf', { type: 'application/pdf' })])
    expect(
      await screen.findByRole('button', { name: 'Attach 2 files' })
    ).toBeInTheDocument()
    expect(screen.getByText('a.pdf', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('b.pdf', { exact: false })).toBeInTheDocument()
  })

  // FILE-7: a queued file can be dropped from the queue before uploading.
  it('a queued file can be removed before upload', async () => {
    listCourseAttachments.mockResolvedValue([])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No files attached yet.')

    chooseFiles([
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ])
    await screen.findByRole('button', { name: 'Attach 2 files' })

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove a.pdf from the queue' })
    )

    expect(
      await screen.findByRole('button', { name: 'Attach 1 file' })
    ).toBeInTheDocument()
    expect(
      screen.queryByText('a.pdf', { exact: false })
    ).not.toBeInTheDocument()
    expect(screen.getByText('b.pdf', { exact: false })).toBeInTheDocument()
  })

  // FILE-7: the queue uploads sequentially, one `attachCourseFile` call per
  // file, and refreshes the list once done.
  it('upload dispatches one attach per queued file, in order', async () => {
    listCourseAttachments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        attachment({ id: 'att-1', filename: 'a.pdf', status: 'pending' }),
        attachment({ id: 'att-2', filename: 'b.pdf', status: 'pending' }),
      ])
    attachCourseFile
      .mockResolvedValueOnce({ attachmentId: 'att-1', jobId: 'job-1' })
      .mockResolvedValueOnce({ attachmentId: 'att-2', jobId: 'job-2' })

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No files attached yet.')

    chooseFiles([
      new File(['a-bytes'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b-bytes'], 'b.pdf', { type: 'application/pdf' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Attach 2 files' }))

    await waitFor(() => expect(attachCourseFile).toHaveBeenCalledTimes(2))
    expect(attachCourseFile).toHaveBeenNthCalledWith(
      1,
      'org-1',
      'course-1',
      expect.objectContaining({ filename: 'a.pdf' })
    )
    expect(attachCourseFile).toHaveBeenNthCalledWith(
      2,
      'org-1',
      'course-1',
      expect.objectContaining({ filename: 'b.pdf' })
    )

    expect(await screen.findByText('a.pdf')).toBeInTheDocument()
    expect(screen.getByText('b.pdf')).toBeInTheDocument()
  })

  // FILE-7: a failure part-way through the queue stops the upload, shows
  // the error, and leaves the files that were never sent still queued —
  // nothing is silently discarded.
  it('a failure part-way leaves the unsent files queued and shows the error', async () => {
    listCourseAttachments.mockResolvedValue([])
    attachCourseFile
      .mockResolvedValueOnce({ attachmentId: 'att-1', jobId: 'job-1' })
      .mockRejectedValueOnce(new ApiError(413, { error: 'invalid_request' }))

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('No files attached yet.')

    chooseFiles([
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
      new File(['c'], 'c.pdf', { type: 'application/pdf' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Attach 3 files' }))

    await waitFor(() => expect(attachCourseFile).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    // `a.pdf` was sent (and removed from the queue); `b.pdf` failed; `c.pdf`
    // was never attempted — both `b.pdf` and `c.pdf` are still queued so
    // the instructor can retry without re-choosing them.
    expect(
      screen.queryByText('a.pdf', { exact: false })
    ).not.toBeInTheDocument()
    expect(screen.getByText('b.pdf', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('c.pdf', { exact: false })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Attach 2 files' })
    ).toBeInTheDocument()
  })

  // FILE-7: the client-side budget pre-check refuses before ever calling
  // the server, using the same wording the server's own refusal would.
  it('refuses locally when the queue would put the course over its 100 MB budget', async () => {
    listCourseAttachments.mockResolvedValue([
      attachment({
        id: 'att-1',
        filename: 'existing.pdf',
        sizeBytes: 99 * 1024 * 1024,
      }),
    ])

    renderWithModal(
      <CourseAttachments organizationId="org-1" courseId="course-1" />
    )
    await screen.findByText('existing.pdf')

    const oversized = new File(
      [new Uint8Array(2 * 1024 * 1024)],
      'two-mb.pdf',
      { type: 'application/pdf' }
    )
    chooseFiles([oversized])
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1 file' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(
      screen.getByText(
        'That file would put this course over its 100 MB total. 99 MB of 100 MB is already used.'
      )
    ).toBeInTheDocument()
    expect(attachCourseFile).not.toHaveBeenCalled()
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

    chooseFiles([
      new File(['x'.repeat(10)], 'huge.pdf', {
        type: 'application/pdf',
      }),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1 file' }))

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

  // FILE-7 — the regression that matters: clicking the delete icon
  // dispatches the detach immediately, with no confirmation dialog first.
  it('clicking the delete icon dispatches the detach with no confirmation dialog', async () => {
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

    // No dialog ever appears — the dispatch happens synchronously with the
    // click, not after a confirmation.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
