/**
 * `pages/OrganizationSettings.tsx` (WEB-69): the tabbed screen replacing
 * Discord/Team/Usage/Jobs as four separate drawer entries — a real
 * tablist reachable by arrow keys, a tab's own contents mounting only
 * once first opened (Discord excepted, this file's own module comment on
 * why), the Danger zone withheld outright for a non-owner, and per-tab
 * unsaved changes asking the WEB-38 three-answer question before a tab
 * switch or a leave.
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
    softDeleteOrganization,
  }
})

function discordProps(): OrganizationSettingsProps['discord'] {
  return {
    loading: false,
    installedServers: [],
    onRemove: vi.fn(),
  }
}

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

  const onNavigateTab = vi.fn()
  const props: OrganizationSettingsProps = {
    organizationId: 'org-1',
    tab: 'discord',
    onNavigateTab,
    isOwner: true,
    viewerAccountId: 'viewer-1',
    organizationName: 'Org One',
    navigate: vi.fn(),
    refreshAccount: vi.fn().mockResolvedValue(undefined),
    discord: discordProps(),
    ...overrides,
  }
  const result = renderWithModal(<OrganizationSettings {...props} />)
  return { ...result, onNavigateTab, props }
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('OrganizationSettings — tabs and mounting (WEB-69)', () => {
  it('renders a real tablist, one tab per ORGANIZATION_SETTINGS_TABS entry, for an owner', () => {
    renderSettings()
    const tablist = screen.getByRole('tablist', {
      name: 'Organization settings',
    })
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.textContent)
    ).toEqual(['Discord', 'Team', 'Usage', 'Jobs', 'Danger zone'])
  })

  it('withholds the Danger zone tab outright for a non-owner', () => {
    renderSettings({ isOwner: false })
    expect(
      screen.queryByRole('tab', { name: 'Danger zone' })
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(4)
  })

  it("does not fetch a tab's own contents until it is first opened", async () => {
    renderSettings({ tab: 'discord' })
    await screen.findByRole('heading', { name: 'Discord', level: 1 })
    expect(listJobs).not.toHaveBeenCalled()
    expect(fetchOrganizationUsage).not.toHaveBeenCalled()
    expect(listMemberships).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }))
    await waitFor(() => expect(listJobs).toHaveBeenCalledWith('org-1'))
    // Usage and Team, never opened, still have not fetched anything.
    expect(fetchOrganizationUsage).not.toHaveBeenCalled()
    expect(listMemberships).not.toHaveBeenCalled()
  })

  it('the Discord tab is the one exception — its data is threaded through as a prop, never fetched by this screen itself', () => {
    const onRemove = vi.fn()
    renderSettings({
      discord: {
        loading: false,
        installedServers: [{ serverId: 'guild-1', serverName: 'My Server' }],
        onRemove,
      },
    })
    expect(screen.getByText(/My Server/)).toBeInTheDocument()
  })

  it('a tab stays mounted once visited, even after switching away', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }))
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
    // Switching back to Jobs must not refetch — it never unmounted.
    fireEvent.click(screen.getByRole('tab', { name: 'Jobs' }))
    expect(listJobs).toHaveBeenCalledTimes(1)
  })

  it('arrow keys move the roving tab selection, with wraparound; Home/End jump to the ends', () => {
    renderSettings()
    const discordTab = screen.getByRole('tab', { name: 'Discord' })
    discordTab.focus()
    fireEvent.keyDown(discordTab, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Danger zone' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Danger zone' }), {
      key: 'ArrowRight',
    })
    expect(discordTab).toHaveFocus()
    fireEvent.keyDown(discordTab, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Danger zone' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Danger zone' }), {
      key: 'Home',
    })
    expect(discordTab).toHaveFocus()
  })

  it('calls onNavigateTab when a tab is clicked', () => {
    const { onNavigateTab } = renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    expect(onNavigateTab).toHaveBeenCalledWith('team')
  })

  it('deleting the organization is reachable from the Danger zone tab, owner-only', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Danger zone' }))
    expect(
      await screen.findByRole('button', { name: 'Delete organization' })
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

  it('a dirty Usage tab asks before switching; Cancel leaves the edit and the tab untouched', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    await screen.findByRole('heading', { name: 'Usage', level: 1 })
    await screen.findByText(
      'No spending cap set — the assistant answers without a spending ceiling.'
    )
    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5' },
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(screen.getByRole('tab', { name: /^Usage/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByLabelText('Spending cap ($)')).toHaveValue('5')
  })

  it('Discard changes clears the edit and moves to the tab clicked', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    await screen.findByRole('heading', { name: 'Usage', level: 1 })
    await screen.findByText(
      'No spending cap set — the assistant answers without a spending ceiling.'
    )
    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5' },
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
      fireEvent.click(screen.getByRole('tab', { name: /^Usage/ }))
    )
    expect(screen.getByLabelText('Spending cap ($)')).toHaveValue('')
  })

  it('Save changes actually saves, then moves to the tab clicked', async () => {
    setSpendingCap.mockResolvedValue({ id: 'org-1' })
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    await screen.findByRole('heading', { name: 'Usage', level: 1 })
    await screen.findByText(
      'No spending cap set — the assistant answers without a spending ceiling.'
    )
    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5' },
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())
    await waitFor(() => expect(setSpendingCap).toHaveBeenCalledWith('org-1', 5))
    expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('Escape means the same as Cancel', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    await screen.findByRole('heading', { name: 'Usage', level: 1 })
    await screen.findByText(
      'No spending cap set — the assistant answers without a spending ceiling.'
    )
    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5' },
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
    expect(screen.getByRole('tab', { name: /^Usage/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByLabelText('Spending cap ($)')).toHaveValue('5')
  })

  it('dirty state on one tab does not make a different, clean tab ask', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    await screen.findByRole('heading', { name: 'Usage', level: 1 })
    await screen.findByText(
      'No spending cap set — the assistant answers without a spending ceiling.'
    )
    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5' },
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
            discord={discordProps()}
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
    render(withModal(<Harness tab="usage" />))

    await screen.findByText(
      'No spending cap set — the assistant answers without a spending ceiling.'
    )
    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5' },
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
