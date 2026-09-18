/**
 * `components/RosterImport.tsx` (WEB-21): the screen a roster import was
 * missing entirely. Every case below is what that component's own module
 * comment promises: the format stated on screen, a job polled the same way
 * `ScaffoldButton.tsx`/`CourseAttachments.tsx` already poll one, and a
 * finished report that names every unparseable row by its own line number.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type {
  JobStatus,
  RosterImportAcknowledgement,
  RosterImportReport,
} from '../src/api/types.js'
import { RosterImport } from '../src/components/RosterImport.js'

const { importRoster, getJobStatus, listRosterAcknowledgements } = vi.hoisted(
  () => ({
    importRoster: vi.fn(),
    getJobStatus: vi.fn(),
    listRosterAcknowledgements: vi.fn(),
  })
)

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, importRoster, getJobStatus, listRosterAcknowledgements }
})

function acknowledgement(
  overrides: Partial<RosterImportAcknowledgement> = {}
): RosterImportAcknowledgement {
  return {
    id: 'ack-1',
    organizationId: 'org-1',
    courseId: 'course-1',
    accountId: 'account-1',
    filename: 'roster.csv',
    jobId: 'job-1',
    acknowledgementVersion: '2026-09-18',
    acknowledgedAt: Date.now(),
    ...overrides,
  }
}

// ROST-20: every test below gets an empty list by default — the
// `listRosterAcknowledgements` call this component now makes on mount would
// otherwise call `.then` on `undefined` (an un-mocked `vi.fn()`'s own
// return value) and throw for every single test in this file, not only the
// ones this slice actually added.
beforeEach(() => {
  listRosterAcknowledgements.mockResolvedValue([])
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
    channelNameDisambiguated: [],
    channelOwnershipConflicts: [],
    channelsOrphaned: [],
    unresolvedRoles: [],
    rolesCreated: [],
    categoriesCreated: [],
    categoriesFailed: [],
    categoriesPermissionsNotRepaired: [],
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

/** ROST-19: ticks the acknowledgement checkbox — every test below that
 * actually starts an import needs this now that the box gates the button. */
function acknowledge(): void {
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: /Uploading my students' names, email addresses/,
    })
  )
}

function renderRosterImport(
  overrides: {
    pollIntervalMs?: number
    stillQueuedHintAfterMs?: number
    viewerAccountId?: string
  } = {}
) {
  return render(
    <RosterImport
      organizationId="org-1"
      courseId="course-1"
      courseTitle="Test Course"
      {...overrides}
    />
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

  it('the import button is disabled until a file is chosen and the acknowledgement is ticked', () => {
    renderRosterImport()
    expect(screen.getByRole('button', { name: 'Import roster' })).toBeDisabled()

    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    // ROST-19: choosing a file alone does not enable Import — the box is
    // still unticked.
    expect(screen.getByRole('button', { name: 'Import roster' })).toBeDisabled()

    acknowledge()

    expect(
      screen.getByRole('button', { name: 'Import roster' })
    ).not.toBeDisabled()
  })

  // ROST-19: the acknowledgement above the drop zone — gating only the
  // start of an import, never the choice of a file.
  describe('ROST-19 — the roster acknowledgement', () => {
    it('is unticked on mount, and remains unticked on a fresh mount — never carried over', () => {
      const { unmount } = renderRosterImport()
      expect(
        screen.getByRole('checkbox', {
          name: /Uploading my students' names, email addresses/,
        })
      ).not.toBeChecked()

      acknowledge()
      expect(
        screen.getByRole('checkbox', {
          name: /Uploading my students' names, email addresses/,
        })
      ).toBeChecked()

      unmount()
      renderRosterImport()
      expect(
        screen.getByRole('checkbox', {
          name: /Uploading my students' names, email addresses/,
        })
      ).not.toBeChecked()
    })

    it('choosing a file is possible while the acknowledgement is unticked — only starting the import is gated', () => {
      renderRosterImport()
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      expect(
        screen.getByRole('checkbox', {
          name: /Uploading my students' names, email addresses/,
        })
      ).not.toBeChecked()
    })

    it('with a file chosen and the box unticked, Import is disabled and the on-screen reason is associated with the button', () => {
      renderRosterImport()
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))

      const button = screen.getByRole('button', { name: 'Import roster' })
      expect(button).toBeDisabled()
      const reason = screen.getByText(
        'Tick the acknowledgement above to start the import.'
      )
      expect(reason).toBeInTheDocument()
      expect(button.getAttribute('aria-describedby')).toBe(reason.id)
    })

    it('ticking the box enables Import and the dispatch is unchanged; unticking it again disables Import', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(job({ status: 'pending' }))
      const csvText = 'First,Last,Email,Discord,GitHub\n'

      renderRosterImport()
      chooseFile(rosterFile(csvText))
      const checkbox = screen.getByRole('checkbox', {
        name: /Uploading my students' names, email addresses/,
      })
      const button = screen.getByRole('button', { name: 'Import roster' })

      fireEvent.click(checkbox)
      expect(button).not.toBeDisabled()

      fireEvent.click(checkbox)
      expect(button).toBeDisabled()

      fireEvent.click(checkbox)
      fireEvent.click(button)

      // ROST-20: the chosen file's own name and the wording's own version
      // travel with the dispatch too, alongside everything ROST-15 already
      // sent.
      await waitFor(() =>
        expect(importRoster).toHaveBeenCalledWith(
          'org-1',
          'course-1',
          csvText,
          true,
          'Test Course - STUDENTS',
          'roster.csv',
          '2026-09-18'
        )
      )
    })

    it('names FERPA and links to both /terms and /privacy', () => {
      renderRosterImport()
      expect(screen.getByText(/FERPA/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /terms/ })).toHaveAttribute(
        'href',
        '/terms'
      )
      expect(screen.getByRole('link', { name: /privacy/ })).toHaveAttribute(
        'href',
        '/privacy'
      )
    })
  })

  it('reads the chosen file as text, enqueues the job, and shows it as queued', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))
    const csvText =
      'First,Last,Email,Discord,GitHub\nAda,Lovelace,ada@example.edu,adalovelace,\n'

    renderRosterImport()
    chooseFile(rosterFile(csvText))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    // ROST-15: the checkbox is checked and the base name field already
    // populated by default (`courseTitle` + `" - STUDENTS"`) — both travel
    // with the dispatch without the instructor touching either control.
    await waitFor(() =>
      expect(importRoster).toHaveBeenCalledWith(
        'org-1',
        'course-1',
        csvText,
        true,
        'Test Course - STUDENTS',
        'roster.csv',
        '2026-09-18'
      )
    )
    expect(await screen.findByText('Queued…')).toBeInTheDocument()
  })

  describe('ROST-15 — offering to create student categories', () => {
    it('is checked by default, with the base name field defaulting to the course title plus " - STUDENTS"', () => {
      renderRosterImport()

      expect(
        screen.getByRole('checkbox', {
          name: "Create student categories if they don't exist",
        })
      ).toBeChecked()
      expect(
        screen.getByRole('textbox', {
          name: 'Base name for new categories',
        })
      ).toHaveValue('Test Course - STUDENTS')
    })

    it('unchecking the box hides the base name field and sends false, without a base name override', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(job({ status: 'pending' }))

      renderRosterImport()
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: "Create student categories if they don't exist",
        })
      )
      expect(
        screen.queryByRole('textbox', {
          name: 'Base name for new categories',
        })
      ).not.toBeInTheDocument()

      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      acknowledge()
      fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

      await waitFor(() =>
        expect(importRoster).toHaveBeenCalledWith(
          'org-1',
          'course-1',
          'First,Last,Email,Discord,GitHub\n',
          false,
          'Test Course - STUDENTS',
          'roster.csv',
          '2026-09-18'
        )
      )
    })

    it('an edited base name travels with the dispatch', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(job({ status: 'pending' }))

      renderRosterImport()
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Base name for new categories' }),
        { target: { value: 'Custom Base' } }
      )
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      acknowledge()
      fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

      await waitFor(() =>
        expect(importRoster).toHaveBeenCalledWith(
          'org-1',
          'course-1',
          'First,Last,Email,Discord,GitHub\n',
          true,
          'Custom Base',
          'roster.csv',
          '2026-09-18'
        )
      )
    })

    it('a finished report names a student category created because the roster needed more room', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(
        job({
          status: 'succeeded',
          result: emptyReport({
            categoriesCreated: ['Test Course - STUDENTS 03'],
          }),
        })
      )

      renderRosterImport()
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      acknowledge()
      fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

      const report = await screen.findByTestId('roster-import-report')
      expect(report).toHaveTextContent('Test Course - STUDENTS 03')
    })

    it('a finished report names a student category this run tried and failed to create, and why', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(
        job({
          status: 'succeeded',
          result: emptyReport({
            categoriesFailed: [
              {
                name: 'Test Course - STUDENTS 03',
                reason: 'Discord responded with status 403',
              },
            ],
          }),
        })
      )

      renderRosterImport()
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      acknowledge()
      fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

      const report = await screen.findByTestId('roster-import-report')
      expect(report).toHaveTextContent('Test Course - STUDENTS 03')
      expect(report).toHaveTextContent('Discord responded with status 403')
    })

    // Review round 2's blocker 2: an adopted category's own permission gap
    // used to have nothing rendered for it at all — this fails without
    // `categoriesPermissionsNotRepaired` reaching the panel.
    it('a finished report names a category whose own permissions could not be repaired', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(
        job({
          status: 'succeeded',
          result: emptyReport({
            categoriesPermissionsNotRepaired: [
              {
                name: 'Test Course - STUDENTS 01',
                reason: 'Discord responded with status 403',
              },
            ],
          }),
        })
      )

      renderRosterImport()
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      acknowledge()
      fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

      const report = await screen.findByTestId('roster-import-report')
      expect(report).toHaveTextContent('Test Course - STUDENTS 01')
      expect(report).toHaveTextContent('Discord responded with status 403')
    })

    // Review round 2's "kinder" fix: clearing the base name field while the
    // box stays ticked must not dispatch `''`, which the action's own
    // schema rejects outright.
    it('falls back to the default base name when the field is cleared with the box still ticked', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(job({ status: 'pending' }))

      renderRosterImport()
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Base name for new categories' }),
        { target: { value: '' } }
      )
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      acknowledge()
      fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

      await waitFor(() =>
        expect(importRoster).toHaveBeenCalledWith(
          'org-1',
          'course-1',
          'First,Last,Email,Discord,GitHub\n',
          true,
          'Test Course - STUDENTS',
          'roster.csv',
          '2026-09-18'
        )
      )
    })

    // Round 3: the field stops rendering when the box is unticked, but its
    // state survives — so clearing it and then unticking used to dispatch
    // `''` anyway, past the guard, and the instructor got the bare
    // validation refusal this fallback exists to prevent.
    it('falls back to the default base name even when the box was unticked after the field was cleared', async () => {
      importRoster.mockResolvedValue({ jobId: 'job-1' })
      getJobStatus.mockResolvedValue(job({ status: 'pending' }))

      renderRosterImport()
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Base name for new categories' }),
        { target: { value: '' } }
      )
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: "Create student categories if they don't exist",
        })
      )
      chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
      acknowledge()
      fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

      await waitFor(() =>
        expect(importRoster).toHaveBeenCalledWith(
          'org-1',
          'course-1',
          'First,Last,Email,Discord,GitHub\n',
          false,
          'Test Course - STUDENTS',
          'roster.csv',
          '2026-09-18'
        )
      )
    })
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
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('Line 3: Discord handle is required')
    expect(report).toHaveTextContent('1 added')
  })

  // Rework finding (must-fix): before this, `ambiguousHandles`,
  // `unresolvedRoles` and `limitations` were declared on `RosterImportReport`
  // but nothing in this component ever read them — a report carrying an
  // entry in each rendered only the summary counts, with no sign a real
  // student's own channel access grant was skipped. Each assertion below
  // reads the rendered report, not the presence of a key on the mocked
  // value, so it fails the same way a reviewer clicking through the screen
  // would have noticed it failing.
  it('a finished report names a Discord handle that matched more than one server member, and who it matched', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          ambiguousHandles: [
            {
              line: 4,
              discord: 'alex',
              email: 'alex@example.edu',
              matchedDisplayNames: ['Alex Chen', 'Alex Diaz'],
            },
          ],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('Line 4: alex')
    expect(report).toHaveTextContent('alex@example.edu')
    expect(report).toHaveTextContent('Alex Chen, Alex Diaz')
  })

  // SRV-10: since the worker now tries to create a missing role rather
  // than merely reporting it missing, `unresolvedRoles` means "the server
  // lacked it and this run tried and failed to create it" — the old copy
  // ("Roles not found in the server") is false once the product itself
  // attempts creation, so this pins both the new copy and the reason the
  // attempt failed (`entry.reason`, the same shape `channelsFailed` already
  // carries a reason with). This test fails against the pre-fix copy: the
  // rendered text no longer contains "not found in the server".
  it('a finished report names a role this run tried and failed to create, and why', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          unresolvedRoles: [
            {
              role: 'admins-wd-fa26',
              reason: 'Discord responded with status 403',
            },
          ],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('admins-wd-fa26')
    expect(report).toHaveTextContent('Discord responded with status 403')
    expect(report).not.toHaveTextContent('not found in the server')
  })

  // SRV-10: "what was created is reported" (the SPEC's own words) applies
  // to a role the same way it already does to a channel — this test fails
  // without `rolesCreated` reaching the panel at all.
  it('a finished report names a role this run created because the server lacked it', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          rolesCreated: ['admins-wd-fa26'],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('admins-wd-fa26')
    expect(report).toHaveTextContent('created')
  })

  // ROST-14/ROST-16: the three sections a roster import grew for channel
  // naming and ownership. Each was rendered but never driven with data —
  // `emptyReport()` seeds them as `[]`, so a wrong field name or a crash in
  // roughly fifty lines of new markup would have passed green. These drive
  // each one non-empty and assert the text an instructor actually acts on.
  it('a finished report names a row whose channel name was disambiguated, and who it shares a name with', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          channelNameDisambiguated: [
            {
              line: 2,
              email: 'ada@school.edu',
              baseChannelName: 'ada',
              channelName: 'ada-school-edu',
              sharesSlugWith: ['ada@gmail.com'],
            },
          ],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('ada@school.edu')
    expect(report).toHaveTextContent('ada-school-edu')
    // The other address is what tells an instructor which two rows collide,
    // and it is the one field rendered through a `join` rather than printed
    // directly — the shape most likely to break silently.
    expect(report).toHaveTextContent('ada@gmail.com')
  })

  it('a finished report names a row refused a channel that already belonged to another student', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          channelOwnershipConflicts: [
            {
              line: 3,
              email: 'bob@school.edu',
              conflictingChannelName: 'bob',
              newChannelName: 'bob-school-edu',
            },
          ],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('bob@school.edu')
    expect(report).toHaveTextContent('bob-school-edu')
    expect(report).toHaveTextContent('already somebody else')
  })

  it('a finished report names a channel left stranded by a name that drifted', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          channelsOrphaned: [
            {
              line: 4,
              email: 'cyd@school.edu',
              previousChannelName: 'cyd',
              newChannelName: 'cyd-school-edu',
            },
          ],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent('cyd@school.edu')
    expect(report).toHaveTextContent('stranded')
    expect(report).toHaveTextContent('cyd-school-edu')
  })

  it("a finished report states the run's own structural limitations", async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(
      job({
        status: 'succeeded',
        result: emptyReport({
          limitations: ['This run does not send or pin a welcome message.'],
        }),
      })
    )

    renderRosterImport()
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    const report = await screen.findByTestId('roster-import-report')
    expect(report).toHaveTextContent(
      'This run does not send or pin a welcome message.'
    )
  })

  it('a pending job stuck past the hint threshold says the worker might not be running', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))

    renderRosterImport({ pollIntervalMs: 10, stillQueuedHintAfterMs: 30 })
    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
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
    acknowledge()
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
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })
})

describe('ROST-20 — the roster acknowledgement is recorded, and readable afterwards', () => {
  it("renders the course's own acknowledgements, newest first", async () => {
    listRosterAcknowledgements.mockResolvedValue([
      acknowledgement({
        id: 'ack-2',
        filename: 'second.csv',
        acknowledgedAt: 2000,
      }),
      acknowledgement({
        id: 'ack-1',
        filename: 'first.csv',
        acknowledgedAt: 1000,
      }),
    ])

    renderRosterImport()

    const list = await screen.findByTestId('roster-acknowledgements')
    const entries = list.querySelectorAll('li')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toHaveTextContent('second.csv')
    expect(entries[1]).toHaveTextContent('first.csv')
  })

  // Rework finding (cheap-fix): `entry.accountId` used to render as a bare
  // UUID even for the instructor reading their own acknowledgement — this
  // component has no read that turns an account id into an email or display
  // name (its own doc comment on the D-54 gap), so the viewer's own entry
  // now reads "you" instead, and only a peer's entry still falls back to the
  // bare id.
  it('names the viewer\'s own acknowledgement "you", and a peer\'s by their bare account id', async () => {
    listRosterAcknowledgements.mockResolvedValue([
      acknowledgement({ id: 'ack-1', accountId: 'account-1' }),
      acknowledgement({ id: 'ack-2', accountId: 'account-2' }),
    ])

    renderRosterImport({ viewerAccountId: 'account-1' })

    const list = await screen.findByTestId('roster-acknowledgements')
    const entries = list.querySelectorAll('li')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toHaveTextContent('acknowledged by you')
    expect(entries[1]).toHaveTextContent('acknowledged by account-2')
  })

  it('shows an empty state when the course has no acknowledgements yet', async () => {
    listRosterAcknowledgements.mockResolvedValue([])

    renderRosterImport()

    expect(
      await screen.findByText(
        'No roster has been imported into this course yet.'
      )
    ).toBeInTheDocument()
  })

  it('sends the acknowledgement version and the chosen file name with the import', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))
    const csvText = 'First,Last,Email,Discord,GitHub\n'

    renderRosterImport()
    chooseFile(rosterFile(csvText))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    await waitFor(() =>
      expect(importRoster).toHaveBeenCalledWith(
        'org-1',
        'course-1',
        csvText,
        true,
        'Test Course - STUDENTS',
        'roster.csv',
        '2026-09-18'
      )
    )
  })

  it('refreshes the acknowledgement list once an import starts', async () => {
    importRoster.mockResolvedValue({ jobId: 'job-1' })
    getJobStatus.mockResolvedValue(job({ status: 'pending' }))

    renderRosterImport()
    const callsBeforeImport = listRosterAcknowledgements.mock.calls.length

    chooseFile(rosterFile('First,Last,Email,Discord,GitHub\n'))
    acknowledge()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))

    await waitFor(() =>
      expect(listRosterAcknowledgements.mock.calls.length).toBeGreaterThan(
        callsBeforeImport
      )
    )
  })
})
