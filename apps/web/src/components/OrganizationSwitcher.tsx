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
 */

import type { MembershipSummary } from '../api/types.js'

export interface OrganizationSwitcherProps {
  memberships: MembershipSummary[]
  activeOrganizationId: string
  onChange: (organizationId: string) => void
}

export function OrganizationSwitcher({
  memberships,
  activeOrganizationId,
  onChange,
}: OrganizationSwitcherProps) {
  const active = memberships.find(
    (membership) => membership.organizationId === activeOrganizationId
  )

  // A single membership is the common case (TEN-1's personal organization,
  // created on first sign-in) — shown plainly rather than as a one-item
  // dropdown nobody needs to operate.
  if (memberships.length <= 1) {
    return (
      <p className="organization-switcher" data-testid="organization-switcher">
        Acting in{' '}
        <strong>{active?.organizationName ?? activeOrganizationId}</strong>
        {active ? ` (${active.role})` : ''}
      </p>
    )
  }

  return (
    <label
      className="organization-switcher"
      data-testid="organization-switcher"
    >
      Acting in{' '}
      <select
        aria-label="Organization"
        value={activeOrganizationId}
        onChange={(event) => onChange(event.target.value)}
      >
        {memberships.map((membership) => (
          <option
            key={membership.organizationId}
            value={membership.organizationId}
          >
            {membership.organizationName} ({membership.role})
          </option>
        ))}
      </select>
    </label>
  )
}
