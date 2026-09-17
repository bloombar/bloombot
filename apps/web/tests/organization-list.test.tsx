/**
 * WEB-57/WEB-58: `components/OrganizationList.tsx`'s own kebab — Rename on
 * a row this account owns, Leave on a row it holds a non-owner membership
 * in, and nothing on a connected-only row. Both `Account.tsx`'s own list
 * and `Organizations.tsx`'s own arrival list draw through this one
 * component (that file's own module comment), so a test here covers both.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import {
  OrganizationList,
  type OrganizationListRow,
} from '../src/components/OrganizationList.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { renameOrganization, leaveOrganization } = vi.hoisted(() => ({
  renameOrganization: vi.fn(),
  leaveOrganization: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, renameOrganization, leaveOrganization }
})

const ROWS: OrganizationListRow[] = [
  { organizationId: 'org-1', organizationName: 'Owned Org', role: 'owner' },
  {
    organizationId: 'org-2',
    organizationName: 'Member Org',
    role: 'assistant',
  },
  { organizationId: 'org-3', organizationName: 'Connected Org' },
]

/** The same account `ROWS` above is built from — `refreshAccount`'s own resolved value in the tests below that exercise `handleLeave`'s fallback (code review round 2, must-fix 1: that fallback now reads the *fresh* account, not `rows`, this file's own `ROWS` constant). */
const ACCOUNT: AccountSummary = {
  id: 'account-1',
  email: 'instructor@example.edu',
  memberships: [
    { organizationId: 'org-1', organizationName: 'Owned Org', role: 'owner' },
    {
      organizationId: 'org-2',
      organizationName: 'Member Org',
      role: 'assistant',
    },
  ],
  connectedOrganizations: [
    { organizationId: 'org-3', organizationName: 'Connected Org' },
  ],
}

/** Opens a row's own kebab, by its own `aria-label` — the same device `tests/courses.test.tsx#openCourseMenu` already uses for `CourseRows.tsx`'s identical kebab. */
function openMenu(organizationName: string) {
  fireEvent.click(
    screen.getByRole('button', { name: `Actions for "${organizationName}"` })
  )
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('OrganizationList kebab (WEB-57/WEB-58)', () => {
  it('offers Rename, not Leave, on a row this account owns', () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Owned Org')
    const menu = screen.getByRole('group', {
      name: 'Actions for "Owned Org"',
    })
    expect(
      within(menu).getByRole('button', { name: 'Rename' })
    ).toBeInTheDocument()
    expect(
      within(menu).queryByRole('button', { name: 'Leave' })
    ).not.toBeInTheDocument()
  })

  it('offers Leave, not Rename, on a row this account holds a non-owner membership in', () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Member Org')
    const menu = screen.getByRole('group', {
      name: 'Actions for "Member Org"',
    })
    expect(
      within(menu).getByRole('button', { name: 'Leave' })
    ).toBeInTheDocument()
    expect(
      within(menu).queryByRole('button', { name: 'Rename' })
    ).not.toBeInTheDocument()
  })

  it('offers no menu at all on a connected-only row', () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'Actions for "Connected Org"' })
    ).not.toBeInTheDocument()
  })

  it('rename dispatches the typed name and re-reads the account afterward', async () => {
    renameOrganization.mockResolvedValue({ id: 'org-1', name: 'New Name' })
    const refreshAccount = vi.fn().mockResolvedValue(undefined)
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Owned Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Owned Org"' })
      ).getByRole('button', { name: 'Rename' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'New Name' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))

    await waitFor(() =>
      expect(renameOrganization).toHaveBeenCalledWith('org-1', 'New Name')
    )
    await waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(1))
  })

  it('refuses a blank or whitespace-only name in the dialog, without dispatching', async () => {
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Owned Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Owned Org"' })
      ).getByRole('button', { name: 'Rename' })
    )
    const dialog = await screen.findByRole('dialog')
    const field = within(dialog).getByLabelText('Organization name')
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Rename',
    })
    fireEvent.change(field, { target: { value: '   ' } })
    expect(confirmButton).toBeDisabled()
    expect(renameOrganization).not.toHaveBeenCalled()
  })

  it('leave confirms first, naming the organization, and dispatches only once confirmed', async () => {
    leaveOrganization.mockResolvedValue({ left: true })
    const refreshAccount = vi.fn().mockResolvedValue(undefined)
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Member Org')

    // Cancelling leaves nothing dispatched.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(leaveOrganization).not.toHaveBeenCalled()

    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const secondDialog = await screen.findByRole('dialog')
    fireEvent.click(within(secondDialog).getByRole('button', { name: 'Leave' }))

    await waitFor(() => expect(leaveOrganization).toHaveBeenCalledWith('org-2'))
    await waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(1))
  })

  it('leaving the active organization refreshes, then navigates to another organization the fresh account still belongs to', async () => {
    leaveOrganization.mockResolvedValue({ left: true })
    // Code review (round 2), must-fix 1 — resolves with the *fresh* account
    // (`org-2` already gone), not the stale `ROWS` this component was
    // rendered with: the fallback has to be read from this, not from
    // `rows`, or a second Leave confirmed while this one is still in flight
    // would pick an organization the account has already left.
    let resolveRefresh: (account: AccountSummary) => void = () => undefined
    const refreshAccount = vi.fn(
      () =>
        new Promise<AccountSummary | undefined>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const navigate = vi.fn()
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        activeOrganizationId="org-2"
        onSelectOrganization={vi.fn()}
        navigate={navigate}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))

    await waitFor(() => expect(leaveOrganization).toHaveBeenCalledWith('org-2'))
    // Navigation waits for the refresh to resolve — not fired the instant
    // the leave itself settles.
    expect(navigate).not.toHaveBeenCalled()
    resolveRefresh({
      ...ACCOUNT,
      memberships: ACCOUNT.memberships.filter(
        (membership) => membership.organizationId !== 'org-2'
      ),
    })
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        kind: 'projects',
        organizationId: 'org-1',
      })
    )
  })

  it('a second Leave confirmed while the first is still in flight picks its fallback from the fresh account, not the stale rows either handler closed over', async () => {
    // Code review (round 2), must-fix 1's own concrete failure: leaving B
    // then, before its own refresh resolves, leaving C too — C's fallback
    // must not be B, which the fresh account no longer includes either.
    const rows: OrganizationListRow[] = [
      { organizationId: 'org-b', organizationName: 'Org B', role: 'assistant' },
      { organizationId: 'org-a', organizationName: 'Org A', role: 'owner' },
      { organizationId: 'org-c', organizationName: 'Org C', role: 'assistant' },
    ]
    const accountAfterLeavingB: AccountSummary = {
      id: 'account-1',
      email: 'instructor@example.edu',
      memberships: [
        { organizationId: 'org-a', organizationName: 'Org A', role: 'owner' },
        {
          organizationId: 'org-c',
          organizationName: 'Org C',
          role: 'assistant',
        },
      ],
      connectedOrganizations: [],
    }
    const accountAfterLeavingBoth: AccountSummary = {
      ...accountAfterLeavingB,
      memberships: accountAfterLeavingB.memberships.filter(
        (membership) => membership.organizationId !== 'org-c'
      ),
    }
    leaveOrganization.mockResolvedValue({ left: true })
    let resolveFirstRefresh: (account: AccountSummary) => void = () => undefined
    let refreshCall = 0
    const refreshAccount = vi.fn(() => {
      refreshCall += 1
      if (refreshCall === 1) {
        return new Promise<AccountSummary | undefined>((resolve) => {
          resolveFirstRefresh = resolve
        })
      }
      return Promise.resolve(accountAfterLeavingBoth)
    })
    const navigate = vi.fn()
    renderWithModal(
      <OrganizationList
        rows={rows}
        activeOrganizationId="org-c"
        onSelectOrganization={vi.fn()}
        navigate={navigate}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )

    openMenu('Org B')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Org B"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const bDialog = await screen.findByRole('dialog')
    fireEvent.click(within(bDialog).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(leaveOrganization).toHaveBeenCalledWith('org-b'))

    // B's own refresh has not resolved yet — C's kebab is still enabled
    // (only B's row is busy), the same gap the concrete failure this test
    // guards against relies on.
    openMenu('Org C')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Org C"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const cDialog = await screen.findByRole('dialog')
    fireEvent.click(within(cDialog).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(leaveOrganization).toHaveBeenCalledWith('org-c'))

    resolveFirstRefresh(accountAfterLeavingB)

    // C's own fallback is Org A — the fresh account's only remaining
    // membership — never Org B, which the account has already left.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        kind: 'projects',
        organizationId: 'org-a',
      })
    )
    expect(navigate).not.toHaveBeenCalledWith({
      kind: 'projects',
      organizationId: 'org-b',
    })
  })

  it('leaving the active organization with nothing left in the fresh account falls back to the account screen', async () => {
    leaveOrganization.mockResolvedValue({ left: true })
    const refreshAccount = vi.fn().mockResolvedValue({
      id: 'account-1',
      email: 'instructor@example.edu',
      memberships: [],
      connectedOrganizations: [],
    } satisfies AccountSummary)
    const navigate = vi.fn()
    renderWithModal(
      <OrganizationList
        rows={[
          {
            organizationId: 'org-2',
            organizationName: 'Member Org',
            role: 'assistant',
          },
        ]}
        activeOrganizationId="org-2"
        onSelectOrganization={vi.fn()}
        navigate={navigate}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'account' })
    )
  })

  it('a failed leave is reported and nothing navigates', async () => {
    leaveOrganization.mockRejectedValue(
      new ApiError(403, { error: 'not_authorized' })
    )
    const navigate = vi.fn()
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        activeOrganizationId="org-2"
        onSelectOrganization={vi.fn()}
        navigate={navigate}
        actionLabel="Switch"
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  // Code review (round 2), must-fix 4 — `handleRename`'s own catch mirrors
  // `handleLeave`'s (tested immediately above); a regression dropping
  // `setError` from the rename branch specifically would ship green without
  // this.
  it('a failed rename is reported, and the account is not re-read', async () => {
    renameOrganization.mockRejectedValue(
      new ApiError(403, { error: 'not_authorized' })
    )
    const refreshAccount = vi.fn().mockResolvedValue(undefined)
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={vi.fn()}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Owned Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Owned Org"' })
      ).getByRole('button', { name: 'Rename' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Organization name'), {
      target: { value: 'New Name' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(refreshAccount).not.toHaveBeenCalled()
  })

  // Code review (round 2), must-fix 2 — a Switch/Choose click on a row
  // whose own Leave is still in flight used to reach `onSelectOrganization`
  // regardless: switching into an organization whose membership was about
  // to disappear landed on the signed-in not-found screen the instant the
  // refresh caught up.
  it('disables a row’s own Switch/Choose button while its Leave is in flight', async () => {
    leaveOrganization.mockResolvedValue({ left: true })
    let resolveRefresh: (account: AccountSummary | undefined) => void = () =>
      undefined
    const refreshAccount = vi.fn(
      () =>
        new Promise<AccountSummary | undefined>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const onSelectOrganization = vi.fn()
    renderWithModal(
      <OrganizationList
        rows={ROWS}
        onSelectOrganization={onSelectOrganization}
        navigate={vi.fn()}
        actionLabel="Switch"
        refreshAccount={refreshAccount}
      />
    )
    openMenu('Member Org')
    fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Actions for "Member Org"' })
      ).getByRole('button', { name: 'Leave' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(leaveOrganization).toHaveBeenCalledWith('org-2'))

    const memberRow = screen.getByText('Member Org').closest('li')
    const switchButton = within(memberRow!).getByRole('button', {
      name: 'Switch',
    })
    expect(switchButton).toBeDisabled()
    fireEvent.click(switchButton)
    expect(onSelectOrganization).not.toHaveBeenCalled()

    resolveRefresh(ACCOUNT)
    await waitFor(() => expect(switchButton).not.toBeDisabled())
  })
})
