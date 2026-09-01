/**
 * WEB-3: the panel always knows which organization it is acting in. A
 * single-membership account (the common case — TEN-1's personal
 * organization, created on first sign-in) sees it named plainly; an
 * account in more than one organization gets a control that switches
 * between them and reports which one is now active.
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

    fireEvent.change(select, { target: { value: 'org-2' } })

    // The caller decides what "active" means (`pages/Shell.tsx`'s own
    // state) — this component only reports the switch, so `onChange` firing
    // with the new id is the whole contract under test here.
    expect(onChange).toHaveBeenCalledWith('org-2')
  })
})
