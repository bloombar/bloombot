/**
 * WEB-3: shows which organization the panel is acting in, and lets a
 * signed-in account that belongs to more than one switch between them — so
 * a person who teaches in two places cannot act in one while believing
 * they are in the other.
 *
 * There is no route today that turns an organization id into a name
 * (`GET /auth/me` returns only `{ organizationId, role }` per membership —
 * see `docs/DECISIONS.md`), so this shows the id itself and the caller's
 * role in it. That is a real gap, recorded there rather than papered over
 * with a name this app made up.
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
        <strong>{active?.organizationId ?? activeOrganizationId}</strong>
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
            {membership.organizationId} ({membership.role})
          </option>
        ))}
      </select>
    </label>
  )
}
