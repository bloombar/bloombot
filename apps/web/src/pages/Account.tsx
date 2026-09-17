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
 *
 * WEB-55 — the list itself (this file's own former `<ul>`) now lives in
 * `components/OrganizationList.tsx`, factored out so `pages/Organizations.tsx`'s
 * own arrival list can draw the identical presentation; this screen just
 * builds `rows` and passes `activeOrganizationId`/`onSwitchOrganization`/
 * `navigate` straight through, unchanged.
 *
 * WEB-57/WEB-58 — `refreshAccount` is new: `OrganizationList`'s own Rename
 * and Leave, on a row this account owns or holds a non-owner membership in,
 * both re-read `GET /auth/me` afterward (that file's own module comment on
 * why), and this screen has no `refreshSession` of its own to hand it —
 * `pages/Shell.tsx` threads through whatever `App.tsx` gave it, unchanged.
 */

import type { AccountSummary } from '../api/types.js'
import {
  OrganizationList,
  type OrganizationListRow,
} from '../components/OrganizationList.js'
import type { Route } from '../routing/route.js'

export interface AccountProps {
  account: AccountSummary
  activeOrganizationId: string
  onSwitchOrganization: (organizationId: string) => void
  /** WEB-41 — `routing/useRoute.ts`'s own `navigate`, threaded down the same way `pages/Shell.tsx` already threads it to every other screen it renders. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** WEB-57/WEB-58 — `App.tsx`'s own `refreshSession`, threaded through `pages/Shell.tsx` unchanged; passed straight to `OrganizationList` (this file's own module comment on why). */
  refreshAccount: () => Promise<AccountSummary | undefined>
}

export function Account({
  account,
  activeOrganizationId,
  onSwitchOrganization,
  navigate,
  refreshAccount,
}: AccountProps) {
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
        <OrganizationList
          rows={rows}
          activeOrganizationId={activeOrganizationId}
          onSelectOrganization={onSwitchOrganization}
          navigate={navigate}
          actionLabel="Switch"
          refreshAccount={refreshAccount}
        />
      </section>
    </div>
  )
}
