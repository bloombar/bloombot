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

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AccountSummary } from '../src/api/types.js'
import { Account } from '../src/pages/Account.js'

const ACCOUNT: AccountSummary = {
  id: 'account-1',
  email: 'instructor@example.edu',
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
    render(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
      />
    )
    expect(screen.getByText('instructor@example.edu')).toBeInTheDocument()
    expect(screen.getByText('account-1')).toBeInTheDocument()
  })

  it('lists every organization the account can act in — memberships with their role, and connected organizations marked "connected"', () => {
    render(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
      />
    )
    expect(screen.getByText(/Org One/)).toHaveTextContent('(owner)')
    expect(screen.getByText(/Org Two/)).toHaveTextContent('(assistant)')
    // LINK-3: connecting proves an identity, it grants nothing — no role to
    // show, so this reads "connected" rather than inventing one.
    expect(screen.getByText(/A University/)).toHaveTextContent('(connected)')
  })

  it('marks which organization is active, and offers no switch control for it', () => {
    render(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
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
    render(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={onSwitchOrganization}
        navigate={vi.fn()}
      />
    )
    const inactiveRow = screen.getByText(/Org Two/).closest('li')
    fireEvent.click(inactiveRow!.querySelector('button') as HTMLButtonElement)
    expect(onSwitchOrganization).toHaveBeenCalledWith('org-2')
  })

  it('offers a switch control for a connected-only organization too, not only a membership', () => {
    const onSwitchOrganization = vi.fn()
    render(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={onSwitchOrganization}
        navigate={vi.fn()}
      />
    )
    const connectedRow = screen.getByText(/A University/).closest('li')
    fireEvent.click(connectedRow!.querySelector('button') as HTMLButtonElement)
    expect(onSwitchOrganization).toHaveBeenCalledWith('org-3')
  })

  // --- WEB-41: each row's own name is a real link ---------------------

  it('renders each organization row as a link to that organization’s main page', () => {
    render(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={vi.fn()}
      />
    )
    // A real `href`, built the same way `buildPath` builds every other
    // address in this app — visible on hover, and "copy link" works. The
    // link's accessible name carries the trailing role label alongside the
    // name (`Account.tsx`'s own comment on why it is one link, not two
    // adjoining pieces of clickable text), so this matches on a prefix.
    expect(screen.getByRole('link', { name: /^Org One/ })).toHaveAttribute(
      'href',
      '/o/org-1/projects'
    )
    expect(screen.getByRole('link', { name: /^Org Two/ })).toHaveAttribute(
      'href',
      '/o/org-2/projects'
    )
    expect(screen.getByRole('link', { name: /^A University/ })).toHaveAttribute(
      'href',
      '/o/org-3/projects'
    )
  })

  it('an ordinary click navigates client-side rather than reloading the page', () => {
    const navigate = vi.fn()
    render(
      <Account
        account={ACCOUNT}
        activeOrganizationId="org-1"
        onSwitchOrganization={vi.fn()}
        navigate={navigate}
      />
    )
    const link = screen.getByRole('link', { name: /^Org Two/ })
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
      render(
        <Account
          account={ACCOUNT}
          activeOrganizationId="org-1"
          onSwitchOrganization={vi.fn()}
          navigate={navigate}
        />
      )
      const link = screen.getByRole('link', { name: /^Org Two/ })
      const event = fireEvent.click(link, eventInit)
      // Not prevented — a modified or non-primary click has to reach the
      // browser's own "open in a new tab" handling, which only happens if
      // this component leaves the event alone.
      expect(event).toBe(true)
      expect(navigate).not.toHaveBeenCalled()
    }
  )
})
