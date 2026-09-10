/**
 * WEB-30 — the account-settings screen the header's own profile control
 * (`AppShell.tsx`'s `headerEnd`, `pages/Shell.tsx`'s own wiring) opens:
 * who this account is (its email, the identity every sign-in and every
 * membership grant in this app is keyed on), every organization it can act
 * in, and a way to switch.
 *
 * **No new API route, no new action.** Everything this screen shows —
 * `account.id`, `account.email`, `account.memberships`,
 * `account.connectedOrganizations` — is already in `GET /auth/me`'s own
 * response (`api/types.ts#AccountSummary`), which `pages/Shell.tsx` already
 * holds by the time this screen can even be reached. This component takes
 * that summary as a prop rather than fetching anything of its own.
 *
 * **One list, both relationships, the same shape `OrganizationSwitcher.tsx`
 * already draws.** A membership (an administrative role — owner, instructor
 * or assistant, TEN-1) and a connected-only relationship (LINK-3's proof of
 * identity, LINK-10) both name an organization this account can switch its
 * active context to; the difference is only what each row's own trailing
 * label says, `role` or "connected" — the identical `role ?? 'connected'`
 * reasoning `OrganizationSwitcher.tsx`'s own module comment already gives.
 *
 * **The active organization is marked, not merely listed — and switching
 * from here uses the same `onSwitchOrganization` callback the header's own
 * switcher uses**, so a switch made from this screen and a switch made from
 * the header are the same operation, not two independently maintained
 * paths that could drift (`pages/Shell.tsx`'s own `setActiveOrganizationId`
 * is the one place either ever lands).
 *
 * WEB-41 — each row's own name is now also a link to that organization's
 * main page, via the shared `AppLink` — this adds a way to *open* an
 * organization, alongside (not instead of) the existing switch control:
 * switching changes which organization this whole shell is acting in,
 * opening the link only reads that organization's own screen without
 * disturbing the active one at all. That screen is Projects for a
 * membership and Chat for a connected-only relationship (`routeForTab`,
 * the same member-vs-connected split `Shell.tsx#effectiveTab` already
 * enforces server-side-adjacent — a connected-only row's link must not
 * advertise a screen that account can never actually reach there).
 */

import type { AccountSummary } from '../api/types.js'
import { AppLink } from '../components/AppLink.js'
import { Button } from '../components/Button.js'
import { routeForTab, type Route } from '../routing/route.js'

export interface AccountProps {
  account: AccountSummary
  activeOrganizationId: string
  onSwitchOrganization: (organizationId: string) => void
  /** WEB-41 — `routing/useRoute.ts`'s own `navigate`, threaded down the same way `pages/Shell.tsx` already threads it to every other screen it renders. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

/** One row this screen can render — a membership's own role, or `undefined` for a connected-only relationship, the same `Option` shape `OrganizationSwitcher.tsx` already draws from the identical two fields. */
interface OrganizationRow {
  organizationId: string
  organizationName: string
  role?: string
}

export function Account({
  account,
  activeOrganizationId,
  onSwitchOrganization,
  navigate,
}: AccountProps) {
  const rows: OrganizationRow[] = [
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

  return (
    <div className="flex flex-col gap-6" data-testid="account-page">
      <h1 className="text-page-title font-semibold text-neutral-900">
        Account
      </h1>

      <section aria-label="Who this account is" className="flex flex-col gap-1">
        <p className="text-sm font-medium text-neutral-900">{account.email}</p>
        <p className="text-sm text-neutral-500">{account.id}</p>
      </section>

      <section
        aria-label="Organizations"
        className="flex flex-col gap-2 border-t border-neutral-200 pt-4"
      >
        <h2 className="text-section-title font-semibold text-neutral-900">
          Organizations
        </h2>
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
                    {/* WEB-41 rework — the organization's own main page, not
                        a switch: opening this does not change which
                        organization is active (`onSwitchOrganization`,
                        below, still owns that). The role label sits
                        *outside* the link, matching the header's own
                        `OrganizationSwitcher.tsx` (that file's own module
                        comment on why) — a link's accessible name should
                        not announce the account's own relationship to the
                        destination, and the role label is not itself a
                        second destination to click. A membership's own
                        `projects` and a connected-only relationship's
                        `chat` mirror `Shell.tsx#effectiveTab`'s own
                        member-vs-connected split (`OrganizationSwitcher.tsx`'s
                        identical fix) — a connected-only row would otherwise
                        advertise, and briefly open, a Projects screen this
                        account can never actually reach there. */}
                    {/* WEB-41 rework (finding 6) — a hover underline
                        here, deliberately: this settings list is not the
                        header, which the brief for this slice explicitly
                        froze ("same font, size, weight, color, spacing" —
                        `OrganizationSwitcher.tsx`'s own link stays bare for
                        that reason alone), so there is no reason to leave
                        this row's own link with no hover affordance at
                        all. */}
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
                  {isActive && (
                    <p className="text-sm text-neutral-500">Active</p>
                  )}
                </div>
                {!isActive && (
                  <Button
                    variant="secondary"
                    onClick={() => onSwitchOrganization(row.organizationId)}
                  >
                    Switch
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
