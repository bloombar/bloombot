/**
 * WEB-55: `pages/Organizations.tsx` — the arrival list a multi-organization
 * account lands on, reusing `components/OrganizationList.tsx`'s own
 * presentation (`Account.tsx`'s own list, factored out — that file's own
 * module comment on why). `navigate` below is a bare `vi.fn()` for tests
 * that do not themselves assert on it, the same convention
 * `tests/account.test.tsx` already holds itself to.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AccountSummary } from '../src/api/types.js'
import { Organizations } from '../src/pages/Organizations.js'

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

describe('Organizations (WEB-55)', () => {
  it('names the screen, and lists every organization the account can act in — memberships with their role, and connected organizations marked "connected"', () => {
    render(<Organizations account={ACCOUNT} navigate={vi.fn()} />)
    expect(
      screen.getByRole('heading', { name: 'Choose an organization' })
    ).toBeInTheDocument()
    expect(screen.getByText(/Org One/).closest('p')).toHaveTextContent(
      '(owner)'
    )
    expect(screen.getByText(/Org Two/).closest('p')).toHaveTextContent(
      '(assistant)'
    )
    expect(screen.getByText(/A University/).closest('p')).toHaveTextContent(
      '(connected)'
    )
  })

  // Nothing is "active" yet at this address — every row offers its own
  // action button, unlike `Account.tsx` where the active one has none.
  it('marks no organization as active, and offers a "Choose" button for every row', () => {
    render(<Organizations account={ACCOUNT} navigate={vi.fn()} />)
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Choose' })).toHaveLength(3)
  })

  it('choosing a membership organization navigates to its Projects screen', () => {
    const navigate = vi.fn()
    render(<Organizations account={ACCOUNT} navigate={navigate} />)
    const row = screen.getByText(/Org Two/).closest('li')
    fireEvent.click(row!.querySelector('button') as HTMLButtonElement)
    expect(navigate).toHaveBeenCalledWith({
      kind: 'projects',
      organizationId: 'org-2',
    })
  })

  // WEB-41's own member-vs-connected split (`Shell.tsx#effectiveTab`) — a
  // connected-only organization opens on Chat, never Projects, the screen
  // that account can never actually reach there.
  it('choosing a connected-only organization navigates to its Chat screen, not Projects', () => {
    const navigate = vi.fn()
    render(<Organizations account={ACCOUNT} navigate={navigate} />)
    const row = screen.getByText(/A University/).closest('li')
    fireEvent.click(row!.querySelector('button') as HTMLButtonElement)
    expect(navigate).toHaveBeenCalledWith({
      kind: 'chat',
      organizationId: 'org-3',
    })
  })

  // WEB-41 — each row's own name is also a real link, the same device
  // `Account.tsx`'s own rows already have (`OrganizationList.tsx`'s own
  // module comment on the shared presentation).
  it('renders each row’s own name as a link to its organization’s main page', () => {
    render(<Organizations account={ACCOUNT} navigate={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'Org One' })).toHaveAttribute(
      'href',
      '/o/org-1/projects'
    )
    expect(screen.getByRole('link', { name: 'A University' })).toHaveAttribute(
      'href',
      '/o/org-3/chat'
    )
  })
})
