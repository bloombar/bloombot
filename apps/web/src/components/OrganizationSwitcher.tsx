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
 *
 * WEB-41 — the single-organization case's plain-text name is now also a
 * link, to that organization's main page (`{ kind: 'projects',
 * organizationId }`), via the shared `AppLink`. The multi-organization
 * `<select>` is untouched: it already navigates the moment a different
 * option is chosen (`onChange`), and a link inside an `<option>` is not a
 * thing HTML has. Same classes as before either way (this file's own
 * "no design change" — WEB-41's brief states this explicitly for the
 * header).
 */

import type {
  ConnectedOrganizationSummary,
  MembershipSummary,
} from '../api/types.js'
import { routeForTab, type Route } from '../routing/route.js'
import { AppLink } from './AppLink.js'

export interface OrganizationSwitcherProps {
  memberships: MembershipSummary[]
  connectedOrganizations: ConnectedOrganizationSummary[]
  activeOrganizationId: string
  onChange: (organizationId: string) => void
  /** WEB-41 — `routing/useRoute.ts`'s own `navigate`, already wrapped in `pages/Shell.tsx`'s own `guardedNavigate` (WEB-16) before it reaches here — the same guarding `changeActiveOrganization`'s own call to this component's `onChange` already gets, so a dirty form elsewhere in the tree gets the same say before this link is honoured that it gets before every other navigation this shell starts. Only the single-organization plain-text case (below) uses it. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
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
  navigate,
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
    // WEB-41 — a member reaches this organization's Projects tab; a
    // connected-only person (this option's own `role === undefined`,
    // exactly how "connected" above is already decided) is forced to Chat
    // by `Shell.tsx`'s own `effectiveTab` the moment they land anywhere
    // else in that organization, and it replaces the address to match
    // (`Shell.tsx`'s own module comment on that rule) — a link to Projects
    // would hover- and cmd-click-advertise a screen this account never
    // actually reaches, and a plain click would flash it before the
    // replace corrected it. `routeForTab` is the same mapping
    // `Shell.tsx#onHome` already uses one line above `isMember`'s own
    // definition there.
    const activeRoute = active
      ? routeForTab(
          active.role !== undefined ? 'projects' : 'chat',
          active.organizationId
        )
      : undefined
    return (
      <p
        className="text-sm font-medium text-neutral-900"
        data-testid="organization-switcher"
      >
        {/* WEB-41 — a link to this organization's main page. No classes of
            its own: Tailwind's Preflight already resets an anchor's color
            and text-decoration to `inherit`, and font-size/weight are
            inherited by any element regardless, so this reads exactly as
            the plain text it replaces (the brief's own "same font, size,
            weight, color, spacing" — no underline, no brand color to
            resist adding here). The role label stays outside the link
            (`Account.tsx`'s own rows now match this, WEB-41 rework) — one
            clickable name, one non-clickable label, not a link whose
            accessible name announces the account's own relationship. */}
        {active && activeRoute ? (
          <AppLink to={activeRoute} navigate={navigate}>
            {active.organizationName}
          </AppLink>
        ) : (
          activeOrganizationId
        )}
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
