/**
 * WEB-55 — the list of every organization a signed-in account can act in,
 * one row per membership or connected identity, factored out of
 * `pages/Account.tsx` (this file's own former "Organizations" section) so
 * `pages/Organizations.tsx`'s own arrival list (WEB-55) can draw the
 * identical presentation rather than a second one invented for it — the
 * brief for this slice asks for exactly that reuse.
 *
 * `activeOrganizationId` is optional: `Account.tsx` always has one (the
 * organization the whole shell is acting in), but the arrival list does
 * not — nothing has been chosen yet at that address, so every row there
 * offers to open it rather than one being marked "Active" with no button of
 * its own. `actionLabel` is the caller's own word for that button —
 * `Account.tsx` keeps "Switch" (this *is* a switch, away from whichever
 * organization is currently active), `Organizations.tsx` uses "Choose"
 * (there is nothing yet to switch away from).
 */

import type { Route } from '../routing/route.js'
import { routeForTab } from '../routing/route.js'
import { AppLink } from './AppLink.js'
import { Button } from './Button.js'

/** One row this list can render — a membership's own role, or `undefined` for a connected-only relationship, the same `role ?? 'connected'` reasoning `OrganizationSwitcher.tsx`'s own module comment already gives. */
export interface OrganizationListRow {
  organizationId: string
  organizationName: string
  role?: string
}

export interface OrganizationListProps {
  rows: OrganizationListRow[]
  /** The organization currently active, marked "Active" with no action button of its own — `undefined` when nothing is active yet (`pages/Organizations.tsx`'s own arrival list). */
  activeOrganizationId?: string
  onSelectOrganization: (organizationId: string) => void
  /** `routing/useRoute.ts`'s own `navigate`, for each row's own name-link (WEB-41's device, unchanged by this extraction). */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** The word on each row's own action button — `Account.tsx`'s "Switch" or `Organizations.tsx`'s "Choose" (this file's own module comment on why they differ). */
  actionLabel: string
}

export function OrganizationList({
  rows,
  activeOrganizationId,
  onSelectOrganization,
  navigate,
  actionLabel,
}: OrganizationListProps) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const isActive = row.organizationId === activeOrganizationId
        return (
          <li
            key={row.organizationId}
            className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
          >
            <div>
              <p className="text-sm font-medium text-neutral-900">
                {/* WEB-41 — the organization's own main page, not a switch:
                    opening this does not change which organization is
                    active (`onSelectOrganization`, below, still owns that).
                    The role label sits *outside* the link (`Account.tsx`'s
                    own former module comment on why — carried over
                    unchanged by this extraction): a link's accessible name
                    should not announce the account's own relationship to
                    the destination. A membership's own `projects` and a
                    connected-only relationship's `chat` mirror
                    `Shell.tsx#effectiveTab`'s own member-vs-connected
                    split. */}
                <AppLink
                  to={routeForTab(
                    row.role !== undefined ? 'projects' : 'chat',
                    row.organizationId
                  )}
                  navigate={navigate}
                  className="hover:underline"
                >
                  {row.organizationName}
                </AppLink>{' '}
                <span className="font-normal text-neutral-500">
                  ({row.role ?? 'connected'})
                </span>
              </p>
              {isActive && <p className="text-sm text-neutral-500">Active</p>}
            </div>
            {!isActive && (
              <Button
                variant="secondary"
                onClick={() => onSelectOrganization(row.organizationId)}
              >
                {actionLabel}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
