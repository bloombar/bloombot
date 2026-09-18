/**
 * WEB-30: `pages/Account.tsx` — who this account is, every organization it
 * can act in, which one is active, and a way to switch. Everything here
 * comes from the same `AccountSummary` `pages/Shell.tsx` already holds
 * (`GET /auth/me`) — no request of this component's own, so this file
 * mounts it directly rather than through `Shell.tsx`'s own async fetches.
 *
 * WEB-41 — each row's own name is also a link to that organization's main
 * page; `navigate` below is a bare `vi.fn()` for every test that does not
 * itself assert on it, the same "supply what the type requires, assert on
 * it only where the test is about it" convention this file already holds
 * for `onSwitchOrganization`.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Account } from '../src/pages/Account.js'
import { renderWithModal } from './helpers/render-with-modal.js'

// WEB-72/DATA-7 — the Danger zone's own delete, mocked the same way every
// other screen's destructive action already is (`tests/projects.test.tsx`'s
// own module comment on this convention). `vi.hoisted` — `vi.mock`'s own
// factory below is hoisted above an ordinary top-level `const`, which would
// otherwise throw "Cannot access 'deleteAccount' before initialization".
const { deleteAccount } = vi.hoisted(() => ({ deleteAccount: vi.fn() }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, deleteAccount }
})

const ACCOUNT: AccountSummary = {
  id: 'account-1',
  email: 'instructor@example.edu',
  isPlatformAdministrator: false,
  memberships: [
    { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' },
    {
      organizationId: 'org-2',
      organizationName: 'Org Two',
      role: 'assistant',
    },
  ],
  connectedOrganizations: [
    { organizationId: 'org-3', organizationName: 'A University' },
  ],
}

describe('Account (WEB-30)', () => {
  it('names the account — its email and id — before anything else', () => {
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    expect(screen.getByText('instructor@example.edu')).toBeInTheDocument()
    expect(screen.getByText('account-1')).toBeInTheDocument()
  })

  it('lists every organization the account can act in — memberships with their role, and connected organizations marked "connected"', () => {
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    // WEB-41 rework (finding 2, coordinator review) — scoped from the
    // row's own `<p>` rather than the matched text node directly: the
    // organization's name is now a link (`Account.tsx`'s own module
    // comment on why the role label sits outside it), so `getByText`
    // alone matches only the anchor, not the trailing role label beside
    // it.
    expect(screen.getByText(/Org One/).closest('p')).toHaveTextContent(
      '(owner)'
    )
    expect(screen.getByText(/Org Two/).closest('p')).toHaveTextContent(
      '(assistant)'
    )
    // LINK-3: connecting proves an identity, it grants nothing — no role to
    // show, so this reads "connected" rather than inventing one.
    expect(screen.getByText(/A University/).closest('p')).toHaveTextContent(
      '(connected)'
    )
  })

  it('marks which organization is active, and offers no switch control for it', () => {
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    const activeRow = screen.getByText(/Org One/).closest('li')
    expect(activeRow).toHaveTextContent('Active')
    expect(
      activeRow &&
        Array.from(activeRow.querySelectorAll('button')).some(
          (button) => button.textContent === 'Switch'
        )
    ).toBe(false)

    const inactiveRow = screen.getByText(/Org Two/).closest('li')
    expect(inactiveRow).not.toHaveTextContent('Active')
    expect(inactiveRow?.querySelector('button')).toHaveTextContent('Switch')
  })

  it('switching to a different organization reports it through onSwitchOrganization', () => {
    const onSwitchOrganization = vi.fn()
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={onSwitchOrganization}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    const inactiveRow = screen.getByText(/Org Two/).closest('li')
    fireEvent.click(inactiveRow!.querySelector('button') as HTMLButtonElement)
    expect(onSwitchOrganization).toHaveBeenCalledWith('org-2')
  })

  it('offers a switch control for a connected-only organization too, not only a membership', () => {
    const onSwitchOrganization = vi.fn()
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={onSwitchOrganization}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    const connectedRow = screen.getByText(/A University/).closest('li')
    fireEvent.click(connectedRow!.querySelector('button') as HTMLButtonElement)
    expect(onSwitchOrganization).toHaveBeenCalledWith('org-3')
  })

  // --- WEB-41: each row's own name is a real link ---------------------

  it('renders each membership row as a link to that organization’s Projects page', () => {
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    // A real `href`, built the same way `buildPath` builds every other
    // address in this app — visible on hover, and "copy link" works. The
    // role label sits outside the anchor (`Account.tsx`'s own module
    // comment, WEB-41 rework finding 2), so the accessible name is the
    // organization's name alone.
    expect(screen.getByRole('link', { name: 'Org One' })).toHaveAttribute(
      'href',
      '/o/org-1/projects'
    )
    expect(screen.getByRole('link', { name: 'Org Two' })).toHaveAttribute(
      'href',
      '/o/org-2/projects'
    )
  })

  // WEB-41 rework (finding 3, coordinator review) — a connected-only
  // relationship (no membership) links to Chat, not Projects: `Shell.tsx`'s
  // own `effectiveTab` forces such an account to Chat the moment it lands
  // anywhere else in that organization and replaces the address to match,
  // so a Projects link would advertise, and briefly open, a screen this
  // account can never actually reach there.
  it('renders a connected-only row as a link to that organization’s Chat page, not Projects', () => {
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    expect(screen.getByRole('link', { name: 'A University' })).toHaveAttribute(
      'href',
      '/o/org-3/chat'
    )
  })

  it('an ordinary click navigates client-side rather than reloading the page', () => {
    const navigate = vi.fn()
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={navigate}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    const link = screen.getByRole('link', { name: 'Org Two' })
    const event = fireEvent.click(link)
    // `fireEvent.click` returns `false` when the event's default was
    // prevented — the actual assertion that this is a client-side
    // navigation, not merely that `navigate` happened to run.
    expect(event).toBe(false)
    expect(navigate).toHaveBeenCalledWith({
      kind: 'projects',
      organizationId: 'org-2',
    })
  })

  it.each([
    ['a cmd/ctrl-click', { metaKey: true }],
    ['a shift-click', { shiftKey: true }],
    ['an alt-click', { altKey: true }],
    ['a middle click', { button: 1 }],
  ])(
    '%s on an organization link falls through to the browser — no navigate, default not prevented',
    (_label, eventInit) => {
      const navigate = vi.fn()
      renderWithModal(
        <Account
          account={ACCOUNT}
          activeOrganizationId="org-1"
          onSwitchOrganization={vi.fn()}
          navigate={navigate}
          refreshAccount={vi.fn().mockResolvedValue(undefined)}
          onSignedOut={vi.fn()}
        />
      )
      const link = screen.getByRole('link', { name: 'Org Two' })
      const event = fireEvent.click(link, eventInit)
      // Not prevented — a modified or non-primary click has to reach the
      // browser's own "open in a new tab" handling, which only happens if
      // this component leaves the event alone.
      expect(event).toBe(true)
      expect(navigate).not.toHaveBeenCalled()
    }
  )
})

// WEB-72/DATA-7 — the Danger zone, last on the screen, holding this
// account's own delete and nothing else.
describe('Account — Danger zone (WEB-72/DATA-7)', () => {
  it('renders the Danger zone last on the screen', () => {
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    const sections = screen.getAllByRole('region')
    expect(sections.at(-1)).toHaveAccessibleName('Danger zone')
  })

  it('cancelling the confirmation sends nothing', async () => {
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deleteAccount).not.toHaveBeenCalled()
  })

  it('typing the wrong email keeps the delete button inert and sends nothing; the exact email proceeds and signs out', async () => {
    deleteAccount.mockResolvedValue(undefined)
    const onSignedOut = vi.fn()
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={onSignedOut}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const dialog = await screen.findByRole('dialog')

    const field = within(dialog).getByLabelText('Email')
    const confirmButton = within(dialog).getByRole('button', {
      name: 'Delete account',
    })
    expect(confirmButton).toBeDisabled()
    fireEvent.change(field, { target: { value: 'wrong@example.edu' } })
    expect(confirmButton).toBeDisabled()
    expect(deleteAccount).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: ACCOUNT.email } })
    expect(confirmButton).not.toBeDisabled()
    fireEvent.click(confirmButton)

    await waitFor(() => expect(deleteAccount).toHaveBeenCalled())
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled())
  })

  it('a failed delete is reported and the account is not signed out', async () => {
    deleteAccount.mockRejectedValue(
      new ApiError(403, { error: 'not_authorized' })
    )
    const onSignedOut = vi.fn()
    renderWithModal(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
        refreshAccount={vi.fn().mockResolvedValue(undefined)}
        onSignedOut={onSignedOut}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: ACCOUNT.email },
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete account' })
    )

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onSignedOut).not.toHaveBeenCalled()
  })
})
