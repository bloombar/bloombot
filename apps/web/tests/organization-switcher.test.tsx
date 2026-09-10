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
 *
 * WEB-41 — the single-organization (plain-text) case's name is also a real
 * link, to that organization's main page. The multi-organization
 * `<select>` case is untouched (`OrganizationSwitcher.tsx`'s own module
 * comment on why); `navigate` below is a bare `vi.fn()` for the tests that
 * do not assert on it.
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
      />
    )
    const select = screen.getByRole('combobox', { name: 'Organization' })
    expect(select).toHaveTextContent("The student's own organization (owner)")
    expect(select).toHaveTextContent('A University (connected)')

    fireEvent.change(select, { target: { value: 'org-2' } })
    expect(onChange).toHaveBeenCalledWith('org-2')
  })

  // --- WEB-41: the single-organization case's name is also a real link ----

  it('renders the single organization’s name as an anchor to its main page', () => {
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
        navigate={vi.fn()}
      />
    )
    // A real `href` — visible on hover, and "copy link" works. The
    // accessible name carries the trailing role label too (this file's own
    // `Acme U (owner)` — `Account.tsx`'s identical choice, its own module
    // comment on why one link, not two adjoining pieces of clickable text).
    expect(screen.getByRole('link', { name: /^Acme U/ })).toHaveAttribute(
      'href',
      '/o/org-1/projects'
    )
  })

  it('an ordinary click on the header’s organization link navigates client-side, not a page reload', () => {
    const navigate = vi.fn()
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
        navigate={navigate}
      />
    )
    const link = screen.getByRole('link', { name: /^Acme U/ })
    const event = fireEvent.click(link)
    // `false` means the click's default was prevented — the actual proof
    // this is a client-side navigation, not merely that `navigate` ran.
    expect(event).toBe(false)
    expect(navigate).toHaveBeenCalledWith({
      kind: 'projects',
      organizationId: 'org-1',
    })
  })

  it.each([
    ['a cmd/ctrl-click', { metaKey: true }],
    ['a shift-click', { shiftKey: true }],
    ['an alt-click', { altKey: true }],
    ['a middle click', { button: 1 }],
  ])(
    '%s on the header’s organization link falls through to the browser',
    (_label, eventInit) => {
      const navigate = vi.fn()
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
          navigate={navigate}
        />
      )
      const link = screen.getByRole('link', { name: /^Acme U/ })
      const event = fireEvent.click(link, eventInit)
      expect(event).toBe(true)
      expect(navigate).not.toHaveBeenCalled()
    }
  )
})
