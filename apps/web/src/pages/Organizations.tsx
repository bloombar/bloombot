/**
 * WEB-55 — the arrival list: shown, in place of guessing, for a signed-in
 * account that belongs to (a member of, or connected to) more than one
 * organization, when nothing else already named a destination
 * (`App.tsx#resolveHomeRoute`'s own module comment has the full ordering —
 * a redeemed join link or a just-completed Discord install still wins over
 * this). Reached at its own address, `/choose-organization`
 * (`routing/route.ts#OrganizationsRoute`), not merely a state this app
 * passes through — bookmarkable and reachable by Back, the same as
 * `pages/Account.tsx`. Not `/organizations`: that segment is reserved for
 * `vite.config.ts`'s own API proxy — `OrganizationsRoute`'s own doc comment
 * has the full collision this address had to avoid.
 *
 * Reuses `components/OrganizationList.tsx`, the identical presentation
 * `pages/Account.tsx`'s own "Organizations" section already draws (that
 * file's own module comment on the extraction) — the brief for this slice
 * asks for exactly that reuse rather than a second list invented here.
 *
 * Unlike `Account.tsx`, nothing here is "active" yet — this *is* the choice
 * of what becomes active, so `activeOrganizationId` is left unset and every
 * row offers its own action button, labelled "Choose" rather than "Switch"
 * (there is nothing yet to switch away from). Choosing a row lands on that
 * organization's own default screen — Projects for a member, Chat for a
 * connected-only relationship — the identical split `resolveHomeRoute`
 * already makes for a fresh sign-in with exactly one organization to land
 * in; a row's own name-link (`OrganizationList`'s own `AppLink`) reaches
 * the same place.
 *
 * Code review, cheap-fix 3 — a precondition guard, because this is a real
 * bookmarkable address, reachable directly rather than only through
 * `resolveHomeRoute`'s own "more than one relationship" check: an account
 * can be sitting on a bookmark of this exact page after WEB-58's own "leave
 * an organization" reduces it back down to one, or (defensively, the same
 * "should not happen but this app does not assume it" discipline
 * `resolveHomeRoute`'s own comment holds itself to) to none at all. Both
 * are redirected on mount, before this screen ever renders its own "you
 * belong to more than one" text over a list that does not actually back
 * that claim — one relationship lands directly in it (the identical
 * membership-then-connected split `resolveDefaultOrganization` already
 * makes), none lands on `/account`, the one address every account can
 * always reach.
 */

import { useEffect } from 'react'

import { resolveDefaultOrganization } from '../account-default-organization.js'
import type { AccountSummary } from '../api/types.js'
import {
  OrganizationList,
  type OrganizationListRow,
} from '../components/OrganizationList.js'
import { LoadingStatus, Skeleton } from '../components/Skeleton.js'
import { routeForTab, type Route } from '../routing/route.js'

export interface OrganizationsProps {
  account: AccountSummary
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

export function Organizations({ account, navigate }: OrganizationsProps) {
  const relationshipCount =
    account.memberships.length + account.connectedOrganizations.length

  // Code review, cheap-fix 3 (this file's own module comment has the full
  // reasoning) — redirects away before ever painting the "more than one"
  // copy over a list that would not actually have more than one row.
  // `replace: true`, the same discipline `resolveHomeRoute`'s own `/`
  // resolution already holds itself to: this screen is not somewhere Back
  // should return into once it turns out there was nothing to choose.
  useEffect(() => {
    if (relationshipCount > 1) return
    const only = resolveDefaultOrganization(account)
    navigate(
      only
        ? routeForTab(only.isMember ? 'projects' : 'chat', only.organizationId)
        : { kind: 'account' },
      { replace: true }
    )
  }, [account, navigate, relationshipCount])

  if (relationshipCount <= 1) {
    // WEB-45 — the same brief, centred skeleton `App.tsx` shows while its
    // own `'home'` route resolves, for the identical reason: the effect
    // above is about to navigate away, and there is nothing this screen
    // should render in the meantime.
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-24" />
        <LoadingStatus />
      </div>
    )
  }

  const rows: OrganizationListRow[] = [
    ...account.memberships.map((membership) => ({
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      role: membership.role,
    })),
    ...account.connectedOrganizations.map((connection) => ({
      organizationId: connection.organizationId,
      organizationName: connection.organizationName,
    })),
  ]

  const isMemberOf = (organizationId: string) =>
    account.memberships.some(
      (membership) => membership.organizationId === organizationId
    )

  return (
    <div className="flex flex-col gap-6" data-testid="organizations-page">
      <h1 className="text-page-title font-semibold text-neutral-900">
        Choose an organization
      </h1>
      <p className="text-sm text-neutral-500">
        You belong to more than one organization — choose which one to open.
      </p>
      <OrganizationList
        rows={rows}
        onSelectOrganization={(organizationId) =>
          navigate(
            routeForTab(
              isMemberOf(organizationId) ? 'projects' : 'chat',
              organizationId
            )
          )
        }
        navigate={navigate}
        actionLabel="Choose"
      />
    </div>
  )
}
