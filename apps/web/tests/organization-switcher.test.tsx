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
 * link, to that organization's main page; `navigate` below is a bare
 * `vi.fn()` for the tests that do not assert on it.
 *
 * WEB-56 — the multi-organization case is a real menu now, not a
 * `<select>` (`components/OrganizationSwitcher.tsx`'s own module comment on
 * why): a trigger naming the active organization, opened on click, listing
 * every option as its own button, marking the active one `aria-current`.
 * Its keyboard, focus and dismissal behaviour is asserted here the same way
 * `tests/kebab-menu.test.tsx` asserts it for the pattern this borrows.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
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

  // --- WEB-56: the multi-organization case is a real menu -----------------

  it('shows the active organization on the closed trigger, with its role, and offers no menu items until opened', () => {
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
        onChange={vi.fn()}
        navigate={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: /Acme U/ })
    expect(trigger).toHaveTextContent('owner')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // WEB-30: no wrapping "Acting in" label — the trigger's own text already
    // reads as the active organization's name.
    expect(screen.queryByText('Acting in')).not.toBeInTheDocument()
    // Not opened yet — Northwind College is only offered once the trigger
    // is activated (the next test).
    expect(screen.queryByText('Northwind College')).not.toBeInTheDocument()
  })

  it('opens on click, offers every membership by name, marks the active one, and reports a switch', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Acme U/ }))

    // Code review, cheap-fix 5 — scoped to the popup itself: the trigger's
    // own accessible name is `Acme U (owner)` too (the active organization,
    // named the same way both places), so an unscoped query for that exact
    // name would match both it and this item.
    const menu = screen.getByRole('group', { name: 'Organizations' })

    // The two-organization user TEN-7 exists for picks between names, not
    // UUIDs.
    const activeItem = within(menu).getByRole('button', {
      name: 'Acme U (owner)',
    })
    expect(activeItem).toHaveAttribute('aria-current', 'true')
    const otherItem = within(menu).getByRole('button', {
      name: 'Northwind College (assistant)',
    })
    expect(otherItem).not.toHaveAttribute('aria-current')

    fireEvent.click(otherItem)

    // The caller decides what "active" means (`pages/Shell.tsx`'s own
    // state) — this component only reports the switch, so `onChange` firing
    // with the new id is the whole contract under test here.
    expect(onChange).toHaveBeenCalledWith('org-2')
    // Closed again, and focus is back on the trigger — the same "never
    // leave focus stranded" discipline `KebabMenu.tsx`'s own item click
    // already holds itself to.
    expect(screen.queryByText('Northwind College')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Acme U/ })).toHaveFocus()
  })

  it('Escape closes the menu and returns focus to the trigger, without reporting a switch', () => {
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
    const trigger = screen.getByRole('button', { name: /Acme U/ })
    fireEvent.click(trigger)
    expect(screen.getByText('Northwind College')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByText('Northwind College')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a click outside the menu closes it, the same as KebabMenu.tsx', () => {
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
        onChange={vi.fn()}
        navigate={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Acme U/ }))
    expect(screen.getByText('Northwind College')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByText('Northwind College')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
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
    fireEvent.click(
      screen.getByRole('button', { name: /The student's own organization/ })
    )
    // Code review, cheap-fix 5 — scoped to the popup: the trigger's own
    // accessible name is the identical string, now that both carry the
    // space the same way (`OrganizationSwitcher.tsx`'s own module comment).
    const menu = screen.getByRole('group', { name: 'Organizations' })
    expect(
      within(menu).getByRole('button', {
        name: "The student's own organization (owner)",
      })
    ).toBeInTheDocument()
    const connectedItem = within(menu).getByRole('button', {
      name: 'A University (connected)',
    })
    expect(connectedItem).toBeInTheDocument()

    fireEvent.click(connectedItem)
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
    // A real `href` — visible on hover, and "copy link" works. The role
    // label sits *outside* the anchor (`OrganizationSwitcher.tsx`'s own
    // module comment on why — `Account.tsx`'s rows now match this too), so
    // the accessible name is the organization's name alone, not "Acme U
    // (owner)".
    expect(screen.getByRole('link', { name: 'Acme U' })).toHaveAttribute(
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
    const link = screen.getByRole('link', { name: 'Acme U' })
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
      const link = screen.getByRole('link', { name: 'Acme U' })
      const event = fireEvent.click(link, eventInit)
      expect(event).toBe(true)
      expect(navigate).not.toHaveBeenCalled()
    }
  )

  // WEB-41 rework (finding 3, coordinator review) — a connected-only
  // relationship links to Chat, not Projects: `Shell.tsx`'s own
  // `effectiveTab` forces such an account to Chat the moment it lands
  // anywhere else in that organization and replaces the address to match,
  // so a Projects link would hover- and cmd-click-advertise a screen this
  // account can never actually reach there.
  it('a single connected-only organization’s link points at Chat, not Projects', () => {
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
    expect(screen.getByRole('link', { name: 'A University' })).toHaveAttribute(
      'href',
      '/o/org-1/chat'
    )
  })
})
