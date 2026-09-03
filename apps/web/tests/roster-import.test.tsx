/**
 * `components/RosterImport.tsx` (WEB-21): the screen a roster import was
 * missing entirely. Every case below is what that component's own module
 * comment promises: the format stated on screen, a job polled the same way
 * `ScaffoldButton.tsx`/`CourseAttachments.tsx` already poll one, and a
 * finished report that names every unparseable row by its own line number.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { JobStatus, RosterImportReport } from '../src/api/types.js'
import { RosterImport } from '../src/components/RosterImport.js'

const { importRoster, getJobStatus } = vi.hoisted(() => ({
  importRoster: vi.fn(),
  getJobStatus: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, importRoster, getJobStatus }
})

function emptyReport(
  overrides: Partial<RosterImportReport> = {}
): RosterImportReport {
  return {
    parseErrors: [],
    peopleCreated: [],
    peopleMerged: [],
    unresolvedHandles: [],
    ambiguousHandles: [],
    channelsCreated: [],
    channelsAlreadyPresent: [],
    channelsNotCreated: [],
    channelsFailed: [],
    channelNameCollisions: [],
    unresolvedRoles: [],
    limitations: [],
    ...overrides,
  }
}

function job(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    id: 'job-1',
    kind: 'roster.import',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/**
 * Choose a file the way a person does — dropping it on the zone. Mirrors
 * `apps/web/tests/course-attachments.test.tsx`'s own `chooseFile` for the
 * same reason: the label names the zone (a real button), not the hidden
 * picker behind it.
 */
function chooseFile(chosen: File): void {
  fireEvent.drop(screen.getByRole('button', { name: /Roster CSV/ }), {
    dataTransfer: { files: [chosen], types: ['Files'] },
  })
}

function rosterFile(text: string): File {
  return new File([text], 'roster.csv', { type: 'text/csv' })
}

function renderRosterImport(
  overrides: {
    pollIntervalMs?: number
    stillQueuedHintAfterMs?: number
  } = {}
) {
  return render(
    <RosterImport organizationId="org-1" courseId="course-1" {...overrides} />
  )
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('RosterImport (WEB-21)', () => {
  it('states the required format on screen: the five headers and a worked example row', () => {
    renderRosterImport()

    expect(
      screen.getByText('First,Last,Email,Discord,GitHub')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Ada,Lovelace,ada@example.edu,adalovelace,adalovelace-gh'
      )
    ).toBeInTheDocument()
    expect(screen.getAllByText(/Email/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Discord/).length).toBeGreaterThan(0)
  })

  it('the import button is disabled until a file is chosen', () => {
    renderRosterImport()
    expect(screen.getByRole('button', { name: 'Import roster' })).toBeDisabled()

    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))

    expect(
      screen.getByRole('button', { name: 'Import roster' })
    ).not.toBeDisabled()
  })

  it('reads the chosen file as text, enqueues the job, and shows it as queued', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))
    const csvText =
      'First,Last,Email,Discord,GitHub\nAda,Lovelace,ada@example.edu,adalovelace,\n'

    renderRosterImport()
    chooseFile(rosterFile(csvText))
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    await waitFor(() =>
      expect(importRoster).toHaveBeenCalledWith('org-1', 'course-1', csvText)
    )
    expect(await screen.findByText('Queued…')).toBeInTheDocument()
  })

  // ROST-9: "every row that could not be parsed with the line number it was
  // on" — this is the assertion that matters for WEB-21.
  it('a finished report names every unparseable row with its own line number', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          parseErrors: [{ line: 3, message: 'Discord handle is required' }],
          peopleCreated: [
            { line: 2, discord: 'adalovelace', personId: 'person-1' },
          ],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('Line 3: Discord handle is required')
    expect(report).toHaveTextContent('1 added')
  })

  it('a pending job stuck past the hint threshold says the worker might not be running', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))

    renderRosterImport({ pollIntervalMs: 10, stillQueuedHintAfterMs: 30 })
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))
    await screen.findByText('Queued…')

    expect(
      screen.queryByText(/make sure the background worker/)
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByText(/make sure the background worker/)
      ).toBeInTheDocument()
    )
  })

  it('a failed job shows its own error text', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({ status: 'failed', lastError: 'no active Discord server bound' })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    expect(await screen.findByText('Failed.')).toBeInTheDocument()
    expect(
      screen.getByText('no active Discord server bound')
    ).toBeInTheDocument()
  })

  it('a refused dispatch renders the same ErrorMessage every other refusal in this app uses', async () => {
    importRoster.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})
