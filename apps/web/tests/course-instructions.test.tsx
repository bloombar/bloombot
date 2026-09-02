/**
 * `components/CourseInstructions.tsx` (WEB-19, FILE-4): the screen a
 * course's instruction history and versioned save were missing entirely —
 * `courseInstructions.save`/`.list`/`.restore` all already existed and were
 * tested, but the panel called none of them, so an edit went through
 * `courses.save` instead and overwrote the last save with no revision, no
 * author and nothing to restore. Every case below is what this component's
 * own module comment promises: a save through the versioned action (not
 * `courses.save`), a visible history with who and when, and a restore that
 * confirms first and is itself recorded as a new revision.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { CourseInstructionRevisionSummary } from '../src/api/types.js'
import { CourseInstructions } from '../src/components/CourseInstructions.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  listCourseInstructionRevisions,
  saveCourseInstructions,
  restoreCourseInstructionRevision,
} = vi.hoisted(() => ({
  listCourseInstructionRevisions: vi.fn(),
  saveCourseInstructions: vi.fn(),
  restoreCourseInstructionRevision: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listCourseInstructionRevisions,
    saveCourseInstructions,
    restoreCourseInstructionRevision,
  }
})

function revision(
  overrides: Partial<CourseInstructionRevisionSummary> = {}
): CourseInstructionRevisionSummary {
  return {
    id: 'rev-1',
    instructions: 'Be helpful.',
    savedByAccountId: 'account-1',
    createdAt: Date.now(),
    ...overrides,
  }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('CourseInstructions (WEB-19)', () => {
  it('shows the empty state when a course has no instructions saved yet', async () => {
    listCourseInstructionRevisions.mockResolvedValue([])

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={vi.fn()}
      />
    )

    expect(
      await screen.findByText('No instructions saved yet.')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Instructions')).toHaveValue('')
  })

  it('prefills the textarea from the newest revision, marks it Current, and offers no restore for it', async () => {
    listCourseInstructionRevisions.mockResolvedValue([
      revision({
        id: 'rev-2',
        instructions: 'Be terse.',
        savedByAccountId: 'account-2',
      }),
      revision({
        id: 'rev-1',
        instructions: 'Be helpful.',
        savedByAccountId: 'account-1',
      }),
    ])

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={vi.fn()}
      />
    )

    expect(await screen.findByDisplayValue('Be terse.')).toBeInTheDocument()
    // FILE-4: the earlier revision's own text is still visible in the
    // history, not only the current one.
    expect(screen.getByText('Be helpful.')).toBeInTheDocument()
    expect(screen.getByText('Current')).toBeInTheDocument()
    expect(screen.getByText(/Saved by account-2/)).toBeInTheDocument()
    expect(screen.getByText(/Saved by account-1/)).toBeInTheDocument()
    // Exactly one restore control — never offered for the current revision.
    expect(
      screen.getAllByRole('button', { name: 'Restore this revision' })
    ).toHaveLength(1)
  })

  it('saves through courseInstructions.save, not courses.save, and the new revision becomes the baseline', async () => {
    listCourseInstructionRevisions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        revision({ id: 'rev-1', instructions: 'Be kind.' }),
      ])
    saveCourseInstructions.mockResolvedValue({
      id: 'course-1',
      instructions: 'Be kind.',
    })

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={vi.fn()}
      />
    )
    await screen.findByText('No instructions saved yet.')

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Be kind.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))

    await waitFor(() =>
      expect(saveCourseInstructions).toHaveBeenCalledWith(
        'org-1',
        'course-1',
        'Be kind.'
      )
    )
    expect(await screen.findByText('Current')).toBeInTheDocument()
    // The history actually re-read from the server, not assumed locally —
    // a save whose own revision the server refused to record for any
    // reason must not be shown as history that does not exist yet.
    expect(listCourseInstructionRevisions).toHaveBeenCalledTimes(2)
  })

  it('an unsaved edit is reported dirty, and a successful save clears it (WEB-16)', async () => {
    listCourseInstructionRevisions
      .mockResolvedValueOnce([revision({ instructions: 'Be helpful.' })])
      .mockResolvedValueOnce([
        revision({ id: 'rev-2', instructions: 'Be kind.' }),
      ])
    saveCourseInstructions.mockResolvedValue({
      id: 'course-1',
      instructions: 'Be kind.',
    })
    const onDirtyChange = vi.fn()

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={onDirtyChange}
      />
    )
    await screen.findByDisplayValue('Be helpful.')
    onDirtyChange.mockClear()

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Be kind.' },
    })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))

    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
    await waitFor(() => expect(saveCourseInstructions).toHaveBeenCalled())
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it('the Save button is disabled until the text actually changes, and while it is blank', async () => {
    listCourseInstructionRevisions.mockResolvedValue([
      revision({ instructions: 'Be helpful.' }),
    ])

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Be helpful.')
    expect(
      screen.getByRole('button', { name: 'Save instructions' })
    ).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: '' },
    })
    expect(
      screen.getByRole('button', { name: 'Save instructions' })
    ).toBeDisabled()
    expect(saveCourseInstructions).not.toHaveBeenCalled()
  })

  it('restore confirms first — cancelling leaves the current instructions exactly as they were', async () => {
    listCourseInstructionRevisions.mockResolvedValue([
      revision({ id: 'rev-2', instructions: 'Be terse.' }),
      revision({ id: 'rev-1', instructions: 'Be helpful.' }),
    ])

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Be terse.')

    fireEvent.click(
      screen.getByRole('button', { name: 'Restore this revision' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Restore this revision?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(restoreCourseInstructionRevision).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('Be terse.')).toBeInTheDocument()
  })

  // The scenario this project's own history keeps naming: an instructor
  // opens a course, changes the instructions, saves, sees the revision
  // appear with an author and a time, then restores the previous one and
  // sees the editor's own contents actually change.
  it('restore, confirmed, dispatches courseInstructions.restore and the editor reflects the restored text', async () => {
    listCourseInstructionRevisions
      .mockResolvedValueOnce([
        revision({ id: 'rev-2', instructions: 'Be terse.' }),
        revision({ id: 'rev-1', instructions: 'Be helpful.' }),
      ])
      .mockResolvedValueOnce([
        revision({ id: 'rev-3', instructions: 'Be helpful.' }),
        revision({ id: 'rev-2', instructions: 'Be terse.' }),
        revision({ id: 'rev-1', instructions: 'Be helpful.' }),
      ])
    restoreCourseInstructionRevision.mockResolvedValue({
      id: 'course-1',
      instructions: 'Be helpful.',
    })

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={vi.fn()}
      />
    )
    await screen.findByDisplayValue('Be terse.')

    fireEvent.click(
      screen.getByRole('button', { name: 'Restore this revision' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Restore this revision?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }))

    await waitFor(() =>
      expect(restoreCourseInstructionRevision).toHaveBeenCalledWith(
        'org-1',
        'rev-1'
      )
    )
    // The restored text is what the editor now shows — the whole point of
    // FILE-4's own restore over merely reading history.
    await waitFor(() =>
      expect(screen.getByDisplayValue('Be helpful.')).toBeInTheDocument()
    )
  })

  it('a load failure renders the refusal', async () => {
    listCourseInstructionRevisions.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(
      <CourseInstructions
        organizationId="org-1"
        courseId="course-1"
        onDirtyChange={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})
