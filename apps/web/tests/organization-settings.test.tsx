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

  // Rework round 2, must-fix 5: the tab-switch prompt's own "Save changes"
  // calls this form's `handleSave` directly, bypassing the Save button's own
  // `disabled` state for a blank name — before the fix, that path refused
  // silently, with nothing telling anyone why the switch never happened.
  it('an emptied name refused through the tab-switch prompt shows a validation error, not a silent refusal', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: '   ' },
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())

    expect(renameOrganization).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an organization name.'
    )
    // The refusal keeps the switch from happening — still on General.
    expect(screen.getByRole('tab', { name: /^General/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  // WEB-69 final polish, must-fix 3: the blank-name error used to linger
  // once shown, even after the person started fixing it — it was only ever
  // cleared by a successful save or a discard.
  it('typing into the name field clears a blank-name validation error', async () => {
    renderSettings()
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: '   ' },
    })
    // The Save button is `disabled` for a blank name (this file's own
    // module comment) — the tab-switch prompt's own "Save changes" is what
    // reaches `handleSave` directly, the same path the case above uses to
    // produce the error in the first place.
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an organization name.'
    )

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'New Name' },
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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

  /**
   * The same `Harness` shape the case above already uses — lifted out since
   * three cases below all need it, each reaching a *different* tab before
   * leaving. `onLeaveAction` defaults to a no-op — most cases only care
   * that the dialog itself behaves correctly, not what `guardedNavigate`
   * would have gone on to do; the leave-refused case below passes a spy to
   * prove the navigation itself never ran.
   */
  function LeaveHarness({
    tab,
    onLeaveAction = () => {},
  }: {
    tab: OrganizationSettingsTab
    onLeaveAction?: () => void
  }) {
    const { guardedNavigate } = useNavigationGuard()
    return (
      <div>
        <button onClick={() => guardedNavigate(onLeaveAction)}>
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

  const USAGE_REPORT = {
    organizationId: 'org-1',
    spendingCapMicros: null,
    totalCostMicros: 0,
    totalEstimatedCostMicros: 0,
    courses: [],
    studentsNearLimit: [],
    bySurface: [],
  }

  /**
   * Rework round 2, must-fix 1: the leave-guard used to act only on
   * `activeTabRef.current` — a hidden tab left dirty by a Back/Forward move
   * between settings tabs (which `routing/route.ts#isSameOrganizationSettingsScreen`
   * lets through without asking) was silently dropped the moment someone
   * left from a *different*, clean tab. `rerender`ing with a new `tab` prop,
   * below, is exactly that move: it changes `activeTab` the same way a
   * `popstate` does, without ever going through this screen's own
   * click-driven `goToTabGuarded`.
   */
  it('Save at leave saves every dirty tab, not just the one on screen, and never re-sends a clean one', async () => {
    listMemberships.mockResolvedValue([])
    fetchOrganizationUsage.mockResolvedValue(USAGE_REPORT)
    renameOrganization.mockResolvedValue({ id: 'org-1', name: 'Changed Name' })

    const { render } = await import('@testing-library/react')
    const { rerender } = render(withModal(<LeaveHarness tab="general" />))

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    rerender(withModal(<LeaveHarness tab="usage" />))
    await screen.findByRole('heading', { name: 'Usage', level: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Leave via drawer' }))
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
    // Usage itself was never dirty — its own Save must never run, which
    // would otherwise silently re-send the unchanged cap.
    expect(setSpendingCap).not.toHaveBeenCalled()
  })

  it('Discard at leave discards every dirty tab, not just the one on screen', async () => {
    listMemberships.mockResolvedValue([])
    listMembershipInvitations.mockResolvedValue([])
    fetchOrganizationUsage.mockResolvedValue(USAGE_REPORT)

    const { render } = await import('@testing-library/react')
    const { rerender } = render(withModal(<LeaveHarness tab="general" />))

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    rerender(withModal(<LeaveHarness tab="team" />))
    await screen.findByRole('heading', { name: 'Team', level: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Leave via drawer' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Discard changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())
    expect(renameOrganization).not.toHaveBeenCalled()

    // The same "only a popstate-style move sees it" path proves the
    // discard actually reached General, not only Team.
    rerender(withModal(<LeaveHarness tab="general" />))
    expect(screen.getByLabelText('Organization name')).toHaveValue('Org One')
  })

  it('Save at leave still succeeds when the tab on screen has no save action of its own (Jobs)', async () => {
    listMemberships.mockResolvedValue([])
    listJobs.mockResolvedValue([])
    renameOrganization.mockResolvedValue({ id: 'org-1', name: 'Changed Name' })

    const { render } = await import('@testing-library/react')
    const { rerender } = render(withModal(<LeaveHarness tab="general" />))

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: 'Changed Name' },
    })

    rerender(withModal(<LeaveHarness tab="jobs" />))
    await screen.findByRole('heading', { name: 'Jobs', level: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Leave via drawer' }))
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
  })

  // Rework round 2, must-fix 2: every tab's own `role="tabpanel"` wrapper
  // now renders — hidden when inactive — regardless of `visitedTabs`, the
  // same rule `pages/CourseEditor.tsx:2106-2123` already holds itself to,
  // so a `role="tab"`'s own `aria-controls` always resolves.
  it("every tab's aria-controls resolves to an element in the DOM on first load", () => {
    renderSettings()
    for (const tab of screen.getAllByRole('tab')) {
      const controlsId = tab.getAttribute('aria-controls')
      expect(controlsId).toBeTruthy()
      expect(document.getElementById(controlsId!)).not.toBeNull()
    }
  })

  // WEB-69 final polish, must-fix 1: `saveAllDirtyTabs` (`pages/OrganizationSettings.tsx`)
  // switches to the first tab whose own save is refused and stops there,
  // but nothing previously proved it — this leaves from a *different* tab
  // (Jobs) than the one whose save fails (General), the same "reach the
  // refusal from a hidden tab" shape the two cases above already use.
  it('leaving with a failed tab save (an emptied name) stays on General, shows the validation error, and does not navigate', async () => {
    listMemberships.mockResolvedValue([])
    listJobs.mockResolvedValue([])

    const { render } = await import('@testing-library/react')
    const onLeaveAction = vi.fn()
    const { rerender } = render(
      withModal(<LeaveHarness tab="general" onLeaveAction={onLeaveAction} />)
    )

    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: '   ' },
    })

    rerender(
      withModal(<LeaveHarness tab="jobs" onLeaveAction={onLeaveAction} />)
    )
    await screen.findByRole('heading', { name: 'Jobs', level: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Leave via drawer' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())

    expect(renameOrganization).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an organization name.'
    )
    // The refusal switches the screen back to the tab that named it, not
    // wherever the leave started from.
    expect(screen.getByRole('tab', { name: /^General/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    // A refused save must never let the leave itself proceed.
    expect(onLeaveAction).not.toHaveBeenCalled()
  })

  // WEB-69 final polish, must-fix 2: the leave-guard used to refuse only
  // while the *active* tab was saving — a hidden tab's own save already in
  // flight (Usage's `setSpendingCap`, here) was not checked at all, so
  // `saveAllDirtyTabs` called that tab's own `save()` a second time on top
  // of the one already running. This is the test that fails without the
  // fix: `setSpendingCap` never resolves, so a double call is observed
  // directly as a second invocation, not merely a second render.
  it('leaving while a hidden tab is still saving does not save that tab a second time', async () => {
    listMemberships.mockResolvedValue([])
    fetchOrganizationUsage.mockResolvedValue(USAGE_REPORT)
    // Never resolves — the in-flight save `saveAllDirtyTabs` must not
    // duplicate.
    setSpendingCap.mockImplementation(() => new Promise(() => {}))

    const { render } = await import('@testing-library/react')
    const { rerender } = render(withModal(<LeaveHarness tab="usage" />))
    // Wait for the report itself to have loaded — the field's own effect
    // seeds `capInput` from it, and a keystroke landed before that resolves
    // would otherwise be overwritten the moment it does.
    await screen.findByText(
      'No spending cap set — the assistant answers without a spending ceiling.'
    )

    fireEvent.change(screen.getByLabelText('Spending cap ($)'), {
      target: { value: '5.00' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save cap' }))
    await waitFor(() => expect(setSpendingCap).toHaveBeenCalledTimes(1))

    // Pop to General the same way a popstate would — General is clean, so
    // the leave-guard's own "is the *active* tab saving" check sees nothing
    // in flight even though Usage, hidden, still is.
    rerender(withModal(<LeaveHarness tab="general" />))
    await screen.findByRole('heading', { name: 'General', level: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Leave via drawer' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Save your changes?',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Save changes' })
    )
    await waitFor(() => expect(dialog).not.toBeVisible())

    expect(setSpendingCap).toHaveBeenCalledTimes(1)
  })
})
