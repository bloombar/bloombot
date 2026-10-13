/**
 * `pages/CourseEditor.tsx` (TEN-11, WEB-80, WEB-81): the Discord server selector is
 * always shown, leads the Discord settings, offers "No Discord", and every
 * other Discord-specific control is shown but disabled while no server is
 * selected. A new course starts with no Discord.
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  Course,
  DiscordServerBindingSummary,
  Project,
} from '../src/api/types.js'
import { CourseEditor } from '../src/pages/CourseEditor.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const {
  getCourse,
  saveCourse,
  listCourseAttachments,
  listCourseInstructionRevisions,
  listCourseJoinLinks,
  listCourseWebSources,
  listCourseEnrolments,
  listDiscordServers,
} = vi.hoisted(() => ({
  getCourse: vi.fn(),
  saveCourse: vi.fn(),
  listCourseAttachments: vi.fn(),
  listCourseInstructionRevisions: vi.fn(),
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
    listCourseAttachments,
    listCourseInstructionRevisions,
    listCourseJoinLinks,
    listCourseWebSources,
    listCourseEnrolments,
    listDiscordServers,
  }
})

const BINDING: DiscordServerBindingSummary = {
  serverId: 'guild-a',
  organizationId: 'org-1',
  installedByAccountId: 'account-1',
  installedAt: 0,
  removedAt: null,
  serverName: 'CS 101',
}

beforeEach(() => {
  listCourseAttachments.mockResolvedValue([])
  listCourseInstructionRevisions.mockResolvedValue([])
  listCourseJoinLinks.mockResolvedValue([])
  listCourseWebSources.mockResolvedValue([])
  listCourseEnrolments.mockResolvedValue([])
  listDiscordServers.mockResolvedValue([BINDING])
})

afterEach(() => {
  vi.resetAllMocks()
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
  adminsRole: 'admins-wd',
  studentsRole: 'students-wd',
  promptId: null,
  instructions: null,
  model: null,
  vectorStoreId: null,
  maxRequestsPerDay: null,
  conversationScope: 'course',
  selfEnrolFromDiscord: false,
  answerUnenrolled: true,
  discordServerId: null,
  discordEnabled: false,
  createdAt: 0,
  aiApprovedAt: 1000,
  categories: [
    {
      id: 'cat-1',
      name: 'Web Design - GLOBAL',
      channels: [{ id: 'chan-1', name: 'announcements', adminsOnly: false }],
    },
  ],
}

function renderExisting() {
  return renderWithModal(
    <CourseEditor
      navigate={vi.fn()}
      organizationId="org-1"
      project={PROJECT}
      courseId="course-1"
      tab="discord"
      onSaved={vi.fn()}
      onOpenChat={vi.fn()}
      onCancel={vi.fn()}
    />
  )
}

function renderNew() {
  return renderWithModal(
    <CourseEditor
      navigate={vi.fn()}
      organizationId="org-1"
      project={PROJECT}
      courseId={undefined}
      onSaved={vi.fn()}
      onOpenChat={vi.fn()}
      onCancel={vi.fn()}
    />
  )
}

/** Every Discord-specific control the brief names, found by its accessible name. */
function discordControls() {
  return {
    adminsRole: screen.getByLabelText('Admins role'),
    studentsRole: screen.getByLabelText('Students role'),
    categoryName: screen.getByLabelText('Category name'),
    addCategory: screen.getByRole('button', { name: 'Add category' }),
    addChannel: screen.getByRole('button', { name: 'Add channel' }),
    scaffold: screen.getByRole('button', { name: 'Create Discord channels' }),
  }
}

describe('CourseEditor Discord tab with a course that uses no Discord (TEN-11, WEB-80)', () => {
  it('leads the tab with the server selector, above the intro copy, roles and categories', async () => {
    getCourse.mockResolvedValue(COURSE)
    renderExisting()

    const select = await screen.findByLabelText('Discord server')
    const panel = screen.getByRole('tabpanel', { name: 'Discord' })
    const intro = within(panel).getByText(/A message reaches this course/)
    const roles = within(panel).getByLabelText('Admins role')
    const position = (a: Element, b: Element) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(position(select, intro)).toBeTruthy()
    expect(position(select, roles)).toBeTruthy()
    expect(select).toHaveValue('none')
  })

  it('disables every Discord-specific control while "No Discord" is selected, keeping them rendered', async () => {
    getCourse.mockResolvedValue(COURSE)
    renderExisting()
    await screen.findByLabelText('Discord server')

    for (const control of Object.values(discordControls())) {
      expect(control).toBeDisabled()
    }
  })

  it('enables them once a server is chosen, and sends both the flag and the server', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue({
      ...COURSE,
      discordEnabled: true,
      discordServerId: 'guild-a',
    })
    renderExisting()
    const select = await screen.findByLabelText('Discord server')
    await screen.findByRole('option', { name: 'CS 101' })

    fireEvent.change(select, { target: { value: 'guild-a' } })

    const { scaffold, ...others } = discordControls()
    for (const control of Object.values(others)) {
      expect(control).toBeEnabled()
    }
    // The scaffold job runs against the saved course, so it waits for a save.
    expect(scaffold).toBeDisabled()
    expect(
      screen.getByText('Save to apply the server change first.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))
    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          discordEnabled: true,
          discordServerId: 'guild-a',
        })
      )
    )
  })

  // WEB-81 — the self-enrolment checkbox lives on the General tab for an
  // existing course and stays editable without Discord; only its wording
  // follows the selected server.
  it('keeps the self-enrolment checkbox enabled with No Discord, with the staff wording, and switches wording once a server is chosen', async () => {
    getCourse.mockResolvedValue(COURSE)
    renderExisting()
    const select = await screen.findByLabelText('Discord server')
    await screen.findByRole('option', { name: 'CS 101' })

    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    expect(
      screen.getByLabelText('Enrol staff who ask this course')
    ).toBeEnabled()
    expect(screen.getByText(/Without Discord this applies only/)).toBeVisible()

    fireEvent.change(select, { target: { value: 'guild-a' } })
    expect(
      screen.getByLabelText('Enrol people who message this course')
    ).toBeEnabled()
    expect(
      screen.getByText(/Anyone who messages this course on Discord/)
    ).toBeVisible()
    expect(
      screen.queryByLabelText('Enrol staff who ask this course')
    ).not.toBeInTheDocument()
  })

  it('saves selfEnrolFromDiscord true after ticking the box with No Discord', async () => {
    getCourse.mockResolvedValue(COURSE)
    saveCourse.mockResolvedValue(COURSE)
    renderExisting()
    await screen.findByLabelText('Discord server')
    await screen.findByRole('option', { name: 'CS 101' })

    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    fireEvent.click(screen.getByLabelText('Enrol staff who ask this course'))
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          selfEnrolFromDiscord: true,
        })
      )
    )
  })

  it('names the selected server in the channels copy', async () => {
    getCourse.mockResolvedValue({
      ...COURSE,
      discordEnabled: true,
      discordServerId: 'guild-a',
    })
    renderExisting()
    await screen.findByLabelText('Discord server')
    await screen.findByRole('option', { name: 'CS 101' })

    expect(
      screen.getByText(/in the Discord server "CS 101"/)
    ).toBeInTheDocument()
  })

  it('disables the controls for the legacy undecidable case (Discord on, no server, two bindings) and offers the placeholder', async () => {
    listDiscordServers.mockResolvedValue([
      BINDING,
      { ...BINDING, serverId: 'guild-b', serverName: null },
    ])
    getCourse.mockResolvedValue({ ...COURSE, discordEnabled: true })
    renderExisting()
    const select = await screen.findByLabelText('Discord server')
    await screen.findByRole('option', { name: 'guild-b' })

    expect(
      within(select).getByRole('option', { name: 'Choose a server…' })
    ).toBeDisabled()
    expect(discordControls().adminsRole).toBeDisabled()
  })

  it('shows a legacy single-binding null course as using that server, with its controls enabled', async () => {
    getCourse.mockResolvedValue({ ...COURSE, discordEnabled: true })
    renderExisting()
    const select = await screen.findByLabelText('Discord server')

    await waitFor(() => expect(select).toHaveValue('guild-a'))
    expect(discordControls().adminsRole).toBeEnabled()
  })

  it('choosing "No Discord" sends discordEnabled false and a null server, and keeps the stored roles', async () => {
    getCourse.mockResolvedValue({
      ...COURSE,
      discordEnabled: true,
      discordServerId: 'guild-a',
    })
    saveCourse.mockResolvedValue(COURSE)
    renderExisting()
    const select = await screen.findByLabelText('Discord server')
    await waitFor(() => expect(select).toHaveValue('guild-a'))

    fireEvent.change(select, { target: { value: 'none' } })
    expect(screen.getByLabelText('Admins role')).toHaveValue('admins-wd')
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() =>
      expect(saveCourse).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          discordEnabled: false,
          discordServerId: null,
          adminsRole: 'admins-wd',
        })
      )
    )
  })
})

describe('CourseEditor while the Discord servers load or fail to load (WEB-80)', () => {
  it('while loading, does not call a stored server "no longer active" or claim none is connected, and locks a legacy null course', async () => {
    listDiscordServers.mockReturnValue(new Promise(() => {}))
    getCourse.mockResolvedValue({
      ...COURSE,
      discordEnabled: true,
      discordServerId: 'guild-a',
    })
    renderExisting()
    const select = await screen.findByLabelText('Discord server')

    expect(select).toBeDisabled()
    expect(select).toHaveValue('guild-a')
    expect(screen.queryByText(/no longer active/)).not.toBeInTheDocument()
    expect(
      screen.queryByText(/no Discord server connected yet/)
    ).not.toBeInTheDocument()
  })

  it('while loading, a legacy null course shows a loading placeholder, not the undecidable one', async () => {
    listDiscordServers.mockReturnValue(new Promise(() => {}))
    getCourse.mockResolvedValue({ ...COURSE, discordEnabled: true })
    renderExisting()
    const select = await screen.findByLabelText('Discord server')

    expect(
      within(select).getByRole('option', { name: 'Loading servers…' })
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/no Discord server connected yet/)
    ).not.toBeInTheDocument()
  })

  it('after a failed load, shows an error, does not mislabel the stored server, and leaves a legacy null course editable', async () => {
    listDiscordServers.mockRejectedValue(new Error('boom'))
    getCourse.mockResolvedValue({ ...COURSE, discordEnabled: true })
    renderExisting()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Could not load this organization/
    )
    expect(
      screen.queryByText(/no Discord server connected yet/)
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/no longer active/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Admins role')).toBeEnabled()
  })

  it('scaffold button and copy follow the saved server: unsaved No Discord does not enable or rename it', async () => {
    getCourse.mockResolvedValue({
      ...COURSE,
      discordEnabled: true,
      discordServerId: 'guild-a',
    })
    renderExisting()
    const select = await screen.findByLabelText('Discord server')
    await screen.findByRole('option', { name: 'CS 101' })
    const scaffold = screen.getByRole('button', {
      name: 'Create Discord channels',
    })
    expect(scaffold).toBeEnabled()

    fireEvent.change(select, { target: { value: 'none' } })

    expect(scaffold).toBeDisabled()
    expect(
      screen.getByText('Save to apply the server change first.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/in the Discord server "CS 101"/)
    ).toBeInTheDocument()
  })
})

describe('CourseEditor new course (TEN-11, WEB-80)', () => {
  it('starts with No Discord, the selector leading the routing section, and the dependent controls disabled', async () => {
    renderNew()

    const select = await screen.findByLabelText('Discord server')
    expect(select).toHaveValue('none')
    const section = screen.getByRole('region', {
      name: 'What this course routes on',
    })
    expect(within(section).getByLabelText('Discord server')).toBe(select)
    expect(screen.getByLabelText('Admins role')).toBeDisabled()
    expect(screen.getByLabelText('Students role')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add category' })).toBeDisabled()
    // WEB-81 — not a Discord-only setting, so it stays editable.
    expect(
      screen.getByLabelText('Enrol staff who ask this course')
    ).toBeEnabled()

    fireEvent.change(select, { target: { value: 'guild-a' } })
    expect(
      screen.getByLabelText('Enrol people who message this course')
    ).toBeEnabled()
  })

  it('saves with discordEnabled false unless a server is chosen', async () => {
    saveCourse.mockResolvedValue(COURSE)
    renderNew()
    await screen.findByLabelText('Discord server')

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Web Design' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }))

    await waitFor(() => expect(saveCourse).toHaveBeenCalled())
    const [, sent] = saveCourse.mock.calls[0] as [
      string,
      { discordEnabled?: boolean; discordServerId?: string | null },
    ]
    expect(sent.discordEnabled).toBe(false)
    expect(sent).not.toHaveProperty('discordServerId')
  })
})
