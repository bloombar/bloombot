/**
 * WEB-55 — the arrival list: shown, in place of guessing, for a signed-in
 * account that belongs to (a member of, or connected to) more than one
 * organization, when nothing else already named a destination
 * (`App.tsx#resolveHomeRoute`'s own module comment has the full ordering —
 * a redeemed join link or a just-completed Discord install still wins over
 * this). Reached at its own address, `/organizations`
 * (`routing/route.ts#OrganizationsRoute`), not merely a state this app
 * passes through — bookmarkable and reachable by Back, the same as
 * `pages/Account.tsx`.
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
 */

import type { AccountSummary } from '../api/types.js'
import {
  OrganizationList,
  type OrganizationListRow,
} from '../components/OrganizationList.js'
import { routeForTab, type Route } from '../routing/route.js'

export interface OrganizationsProps {
  account: AccountSummary
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

export function Organizations({ account, navigate }: OrganizationsProps) {
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
