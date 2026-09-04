/**
 * WEB-30: `pages/Account.tsx` — who this account is, every organization it
 * can act in, which one is active, and a way to switch. Everything here
 * comes from the same `AccountSummary` `pages/Shell.tsx` already holds
 * (`GET /auth/me`) — no request of this component's own, so this file
 * mounts it directly rather than through `Shell.tsx`'s own async fetches.
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
      />
    )
    const connectedRow = screen.getByText(/A University/).closest('li')
    fireEvent.click(connectedRow!.querySelector('button') as HTMLButtonElement)
    expect(onSwitchOrganization).toHaveBeenCalledWith('org-3')
  })
})
