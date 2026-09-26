/**
 * `pages/OrganizationSettings.tsx` (WEB-69): the tabbed screen replacing
 * Discord/Team/Usage/Jobs as four separate drawer entries — a real
 * tablist reachable by arrow keys, a tab's own contents mounting only
 * once first opened (every tab, including Discord since rework round 2 —
 * this file's own module comment on why), a General tab for the
 * organization's own name and (owner-only, at its own bottom) the Danger
 * zone, and per-tab unsaved changes asking the WEB-38 three-answer
 * question before a tab switch or a leave.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OrganizationSettings,
  type OrganizationSettingsProps,
} from '../src/pages/OrganizationSettings.js'
import type { OrganizationSettingsTab } from '../src/routing/route.js'
import { useNavigationGuard } from '../src/hooks/navigation-guard.js'
import { renderWithModal, withModal } from './helpers/render-with-modal.js'

const {
  listMemberships,
  grantMembership,
  revokeMembership,
  listMembershipInvitations,
  createMembershipInvitation,
  revokeMembershipInvitation,
  fetchOrganizationUsage,
  setSpendingCap,
  listJobs,
  listDiscordServers,
  renameOrganization,
  softDeleteOrganization,
} = vi.hoisted(() => ({
  listMemberships: vi.fn(),
  grantMembership: vi.fn(),
  revokeMembership: vi.fn(),
  listMembershipInvitations: vi.fn(),
  createMembershipInvitation: vi.fn(),
  revokeMembershipInvitation: vi.fn(),
  fetchOrganizationUsage: vi.fn(),
  setSpendingCap: vi.fn(),
  listJobs: vi.fn(),
  listDiscordServers: vi.fn(),
  renameOrganization: vi.fn(),
  softDeleteOrganization: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    listMemberships,
    grantMembership,
    revokeMembership,
    listMembershipInvitations,
    createMembershipInvitation,
    revokeMembershipInvitation,
    fetchOrganizationUsage,
    setSpendingCap,
    listJobs,
    listDiscordServers,
    renameOrganization,
    softDeleteOrganization,
  }
})

/** Renders the screen with every dependency defaulted to an empty/idle response, so a test only has to override what it actually cares about. */
function renderSettings(overrides: Partial<OrganizationSettingsProps> = {}) {
  listMemberships.mockResolvedValue([])
  listMembershipInvitations.mockResolvedValue([])
  fetchOrganizationUsage.mockResolvedValue({
    organizationId: 'org-1',
    spendingCapMicros: null,
    totalCostMicros: 0,
    totalEstimatedCostMicros: 0,
    courses: [],
    studentsNearLimit: [],
    bySurface: [],
  })
  listJobs.mockResolvedValue([])
  listDiscordServers.mockResolvedValue([])

  const onNavigateTab = vi.fn()
  const props: OrganizationSettingsProps = {
    organizationId: 'org-1',
    tab: 'general',
    onNavigateTab,
    isOwner: true,
    viewerAccountId: 'viewer-1',
    organizationName: 'Org One',
    navigate: vi.fn(),
    refreshAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  const result = renderWithModal(<OrganizationSettings {...props} />)
  return { ...result, onNavigateTab, props }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('OrganizationSettings — tabs and mounting (WEB-69)', () => {
  it('renders a real tablist, General first, one tab per ORGANIZATION_SETTINGS_TABS entry', () => {
    renderSettings()
    const tablist = screen.getByRole('tablist', {
      name: 'Organization settings',
    })
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['General', 'Discord', 'Team', 'Usage', 'Jobs'])
  })

  it('renders every tab for a non-owner too — a role decides what a tab shows, not whether it exists', () => {
    renderSettings({ isOwner: false })
    expect(screen.getAllByRole('tab')).toHaveLength(5)
  })

  it("does not fetch a tab's own contents until it is first opened", async () => {
    renderSettings({ tab: 'general' })
    await screen.findByRole('heading', { name: 'General', level: 1 })
    expect(listJobs).not.toHaveBeenCalled()
    expect(fetchOrganizationUsage).not.toHaveBeenCalled()
    expect(listMemberships).not.toHaveBeenCalled()
    expect(listDiscordServers).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }))
    await waitFor(() => expect(listJobs).toHaveBeenCalledWith('org-1'))
    // Usage, Team and Discord, never opened, still have not fetched
    // anything.
    expect(fetchOrganizationUsage).not.toHaveBeenCalled()
    expect(listMemberships).not.toHaveBeenCalled()
    expect(listDiscordServers).not.toHaveBeenCalled()
  })

  // Rework round 2: the Discord tab used to be the one exception, eagerly
  // fetched by `pages/Shell.tsx` regardless of which tab was showing. The
  // user's own final decision removes that exception — this is the test
  // that would fail without it.
  it('fetches the Discord list only once the Discord tab is actually opened', async () => {
    renderSettings()
    expect(listDiscordServers).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    await waitFor(() =>
      expect(listDiscordServers).toHaveBeenCalledWith('org-1')
    )
  })

  it('a tab stays mounted once visited, even after switching away', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }))
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'General' }))
    // Switching back to Jobs must not refetch — it never unmounted.
    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }))
    expect(listJobs).toHaveBeenCalledTimes(1)
  })

  it('arrow keys move the roving tab selection, with wraparound; Home/End jump to the ends', () => {
    renderSettings()
    const generalTab = screen.getByRole('tab', { name: 'General' })
    generalTab.focus()
    fireEvent.keyDown(generalTab, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Jobs' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Jobs' }), {
      key: 'ArrowRight',
    })
    expect(generalTab).toHaveFocus()
    fireEvent.keyDown(generalTab, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Jobs' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Jobs' }), {
      key: 'Home',
    })
    expect(generalTab).toHaveFocus()
  })

  it('calls onNavigateTab when a tab is clicked', () => {
    const { onNavigateTab } = renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    expect(onNavigateTab).toHaveBeenCalledWith('team')
  })
})

describe('OrganizationSettings — General tab (WEB-69 rework)', () => {
  it("renders the organization's own name", () => {
    renderSettings({ organizationName: 'Org One' })
    expect(screen.getByDisplayValue('Org One')).toBeInTheDocument()
  })

  it('an owner can rename — the client is called, then refreshAccount', async () => {
    renameOrganization.mockResolvedValue({ id: 'org-1', name: 'New Name' })
    const refreshAccount = vi.fn().mockResolvedValue(undefined)
    renderSettings({ isOwner: true, refreshAccount })

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'New Name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(renameOrganization).toHaveBeenCalledWith('org-1', 'New Name')
    )
    await waitFor(() => expect(refreshAccount).toHaveBeenCalled())
  })

  it('a non-owner sees the name read-only, and no Danger zone', () => {
    renderSettings({ isOwner: false, organizationName: 'Org One' })
    expect(screen.queryByLabelText('Organization name')).not.toBeInTheDocument()
    expect(screen.getByText('Org One')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Delete organization' })
    ).not.toBeInTheDocument()
  })

  it('the Danger zone appears at the bottom of General for an owner', () => {
    renderSettings({ isOwner: true })
    expect(
      screen.getByRole('button', { name: 'Delete organization' })
    ).toBeInTheDocument()
  })
})

describe('OrganizationSettings — per-tab unsaved changes (WEB-38, WEB-69)', () => {
  it('a clean tab never asks when switching away', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    await screen.findByRole('heading', { name: 'Usage', level: 1 })
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('a dirty General name asks before switching; Cancel leaves the edit and the tab untouched', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(screen.getByRole('tab', { name: /^General/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByLabelText('Organization name')).toHaveValue(
      'Changed Name'
    )
  })

  it('Discard changes clears the edit and moves to the tab clicked', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Discard changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await waitFor(() =>
      fireEvent.click(screen.getByRole('tab', { name: /^General/ }))
    )
    expect(screen.getByLabelText('Organization name')).toHaveValue('Org One')
  })

  it('Save changes actually renames, then moves to the tab clicked', async () => {
    renameOrganization.mockResolvedValue({ id: 'org-1', name: 'Changed Name' })
    renderSettings()
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())
    await waitFor(() =>
      expect(renameOrganization).toHaveBeenCalledWith('org-1', 'Changed Name')
    )
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('Escape means the same as Cancel', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    // jsdom's own `<dialog>` gap (`tests/setup.ts`'s own module comment,
    // `modal.test.tsx`'s own identical workaround): this polyfill does not
    // dispatch the native `cancel` event for a real Escape keypress, so
    // this drives the same `onCancel` path `Modal.tsx` wires that event to
    // directly — `e2e/keyboard.spec.ts` is what actually presses the key
    // against a real browser.
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(screen.getByRole('tab', { name: /^General/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByLabelText('Organization name')).toHaveValue(
      'Changed Name'
    )
  })

  it('dirty state on one tab does not make a different, clean tab ask', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })
    // Move to Team via Discard so the screen is now sitting on Team, still
    // carrying no *other* pending edit of its own.
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Discard changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())

    // Team itself is clean — switching away from it asks nothing.
    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  /**
   * WEB-69 — leaving the screen altogether (a drawer click, the home
   * control, an organization switch) asks the identical question, through
   * the navigation guard `pages/Shell.tsx` wraps every one of those in
   * (`hooks/navigation-guard.tsx`). This harness stands in for that
   * wrapper directly, the same way `course-instructions.test.tsx` proves
   * its own component's guard registration without mounting the whole of
   * `pages/CourseEditor.tsx`.
   */
  it('leaving the screen while a tab is dirty asks the same three-answer question', async () => {
    function Harness({ tab }: { tab: OrganizationSettingsTab }) {
      const { guardedNavigate } = useNavigationGuard()
      return (
        <div>
          <button onClick={() => guardedNavigate(() => {})}>
            Leave via drawer
          </button>
          <OrganizationSettings
            organizationId="org-1"
            tab={tab}
            onNavigateTab={() => {}}
            isOwner={true}
            viewerAccountId="viewer-1"
            organizationName="Org One"
            navigate={vi.fn()}
            refreshAccount={vi.fn().mockResolvedValue(undefined)}
          />
        </div>
      )
    }
    listMemberships.mockResolvedValue([])
    fetchOrganizationUsage.mockResolvedValue({
      organizationId: 'org-1',
      spendingCapMicros: null,
      totalCostMicros: 0,
      totalEstimatedCostMicros: 0,
      courses: [],
      studentsNearLimit: [],
      bySurface: [],
    })

    const { render } = await import('@testing-library/react')
    render(withModal(<Harness tab="general" />))

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Leave via drawer' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    expect(dialog).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(dialog).not.toBeVisible())
  })
})
