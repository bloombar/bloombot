/**
 * WEB-3: the panel always knows which organization it is acting in. A
 * single-membership account (the common case — TEN-1's personal
 * organization, created on first sign-in) sees it named plainly; an
 * account in more than one organization gets a control that switches
 * between them and reports which one is now active.
 *
 * WEB-30: restyled for the header's leading edge — no "Acting in" prose,
 * either case (`components/OrganizationSwitcher.tsx`'s own module comment
 * on why there is no longer room to spare for it).
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { OrganizationSwitcher } from '../src/components/OrganizationSwitcher.js'

describe('OrganizationSwitcher (WEB-3)', () => {
  it('shows the single organization plainly, by name — with no control to switch', () => {
    render(
      <OrganizationSwitcher
        memberships={[
          {
            organizationId: 'org-1',
            organizationName: 'Acme U',
            role: 'owner',
          },
        ]}
        connectedOrganizations={[]}
        activeOrganizationId="org-1"
        onChange={vi.fn()}
      />
    )
    // Finding 4 (rework pass): the name, not the raw id — TEN-7's own point.
    expect(screen.getByTestId('organization-switcher')).toHaveTextContent(
      'Acme U'
    )
    expect(screen.getByTestId('organization-switcher')).not.toHaveTextContent(
      'org-1'
    )
    expect(screen.getByTestId('organization-switcher')).toHaveTextContent(
      'owner'
    )
    // WEB-30: no "Acting in" prose — the header has no room to spare for it
    // alongside the name itself.
    expect(screen.getByTestId('organization-switcher')).not.toHaveTextContent(
      'Acting in'
    )
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('offers every membership by name when an account belongs to more than one organization, and reports a switch', () => {
    const onChange = vi.fn()
    render(
      <OrganizationSwitcher
        memberships={[
          {
            organizationId: 'org-1',
            organizationName: 'Acme U',
            role: 'owner',
          },
          {
            organizationId: 'org-2',
            organizationName: 'Northwind College',
            role: 'assistant',
          },
        ]}
        connectedOrganizations={[]}
        activeOrganizationId="org-1"
        onChange={onChange}
      />
    )
    const select = screen.getByRole('combobox', { name: 'Organization' })
    // The two-organization user TEN-7 exists for picks between names, not
    // UUIDs — the select still switches on `organizationId` (`value`
    // below), but what a person reads is `organizationName`.
    expect(select).toHaveValue('org-1')
    expect(select).toHaveTextContent('Acme U')
    expect(select).toHaveTextContent('Northwind College')
    // WEB-30: no wrapping "Acting in" label — the select's own current
    // value already reads as the active organization's name.
    expect(screen.queryByText('Acting in')).not.toBeInTheDocument()

    fireEvent.change(select, { target: { value: 'org-2' } })

    // The caller decides what "active" means (`pages/Shell.tsx`'s own
    // state) — this component only reports the switch, so `onChange` firing
    // with the new id is the whole contract under test here.
    expect(onChange).toHaveBeenCalledWith('org-2')
  })

  // --- LINK-10: a connected-but-not-a-member organization ------------------

  it('shows a single connected-only organization plainly, as "connected" rather than inventing a role it does not have', () => {
    render(
      <OrganizationSwitcher
        memberships={[]}
        connectedOrganizations={[
          { organizationId: 'org-1', organizationName: 'A University' },
        ]}
        activeOrganizationId="org-1"
        onChange={vi.fn()}
      />
    )
    const switcher = screen.getByTestId('organization-switcher')
    expect(switcher).toHaveTextContent('A University')
    // Not a membership role (owner/instructor/assistant) — connecting
    // proves an identity, not administrative authority.
    expect(switcher).toHaveTextContent('connected')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('offers a membership organization alongside a connected-only one, and labels each correctly', () => {
    const onChange = vi.fn()
    render(
      <OrganizationSwitcher
        memberships={[
          {
            organizationId: 'org-1',
            organizationName: "The student's own organization",
            role: 'owner',
          },
        ]}
        connectedOrganizations={[
          { organizationId: 'org-2', organizationName: 'A University' },
        ]}
        activeOrganizationId="org-1"
        onChange={onChange}
      />
    )
    const select = screen.getByRole('combobox', { name: 'Organization' })
    expect(select).toHaveTextContent("The student's own organization (owner)")
    expect(select).toHaveTextContent('A University (connected)')

    fireEvent.change(select, { target: { value: 'org-2' } })
    expect(onChange).toHaveBeenCalledWith('org-2')
  })
})
