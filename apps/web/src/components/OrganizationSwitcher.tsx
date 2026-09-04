/**
 * WEB-3: shows which organization the panel is acting in, and lets a
 * signed-in account that belongs to more than one switch between them — so
 * a person who teaches in two places cannot act in one while believing
 * they are in the other.
 *
 * Finding 4 (rework pass): shows `organizationName`, not the raw id —
 * `GET /auth/me` has carried `{ organizationId, organizationName, role }`
 * per membership since TEN-7 closed that gap (`docs/DECISIONS.md` D-23),
 * this component just did not read the name back yet. Before this fix, an
 * account in two organizations picked between two UUIDs — exactly the case
 * TEN-7 exists for.
 *
 * LINK-10: also offers every organization the account has a *connected*
 * person in but no membership — a student reaching the institution running
 * their course, not an administrator. Combined into one list of `Option`s
 * rather than two separate controls, since "which organization is this
 * panel acting in" is one question regardless of which relationship got the
 * account there; a connected-only option carries no `role` (there is none
 * to show — connecting proves an identity, LINK-3, not administrative
 * authority) and reads "(connected)" in its place, so it never claims a
 * role this account does not actually hold.
 *
 * WEB-30: restyled to sit at the header's leading edge, in the space the
 * nav row vacated (`components/AppShell.tsx`'s own `headerStart` slot) —
 * the "Acting in" prose is dropped (there is no longer room to spare for
 * it next to the home control and, now, the organization name), leaving
 * just the name itself: plain text for the single-organization case, or a
 * `<select>` whose own current value already reads as the active
 * organization's name for the multi-organization case. The `role ?? 'connected'`
 * labelling (this file's own module comment, LINK-10) is unchanged either
 * way.
 */

import type {
  ConnectedOrganizationSummary,
  MembershipSummary,
} from '../api/types.js'

export interface OrganizationSwitcherProps {
  memberships: MembershipSummary[]
  connectedOrganizations: ConnectedOrganizationSummary[]
  activeOrganizationId: string
  onChange: (organizationId: string) => void
}

/** One organization this switcher can offer — a membership's own role, or `undefined` for a connected-only relationship (this file's own module comment). */
interface Option {
  organizationId: string
  organizationName: string
  role?: string
}

export function OrganizationSwitcher({
  memberships,
  connectedOrganizations,
  activeOrganizationId,
  onChange,
}: OrganizationSwitcherProps) {
  const options: Option[] = [
    ...memberships.map((membership) => ({
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      role: membership.role,
    })),
    ...connectedOrganizations.map((connection) => ({
      organizationId: connection.organizationId,
      organizationName: connection.organizationName,
    })),
  ]
  const active = options.find(
    (option) => option.organizationId === activeOrganizationId
  )

  // A single option is the common case (TEN-1's personal organization,
  // created on first sign-in) — shown plainly rather than as a one-item
  // dropdown nobody needs to operate. WEB-30: no "Acting in" prose anymore
  // (this file's own module comment) — just the name, and the role/
  // "connected" label LINK-10 already required.
  if (options.length <= 1) {
    return (
      <p
        className="text-sm font-medium text-neutral-900"
        data-testid="organization-switcher"
      >
        {active?.organizationName ?? activeOrganizationId}
        {active ? (
          <span className="font-normal text-neutral-500">
            {' '}
            ({active.role ?? 'connected'})
          </span>
        ) : (
          ''
        )}
      </p>
    )
  }

  // WEB-30: no wrapping "Acting in" label either — the select's own current
  // value already reads as the active organization's name, and
  // `aria-label` still names the control for anyone not reading it
  // visually.
  return (
    <select
      aria-label="Organization"
      data-testid="organization-switcher"
      value={activeOrganizationId}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-md border border-neutral-300 py-1 pl-2 pr-7 text-sm font-medium text-neutral-900 focus:border-brand-500"
    >
      {options.map((option) => (
        <option key={option.organizationId} value={option.organizationId}>
          {option.organizationName} ({option.role ?? 'connected'})
        </option>
      ))}
    </select>
  )
}
