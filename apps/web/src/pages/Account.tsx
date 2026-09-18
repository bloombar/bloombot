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
 *
 * WEB-72/DATA-7 — a Danger zone, last on the screen, holding this account's
 * own delete and nothing else: the same typed-name gate `useModal()`'s
 * `prompt` already applies to a course/project (`components/CourseRows.tsx`/
 * `hooks/useProjectMenu.tsx`), typed against `account.email` — the one
 * identifier this screen actually shows (this component has no
 * `displayName` field to type against, unlike the console's own
 * `AccountDetail.tsx`). Deleting your own account is deleting the thing
 * you are signed in *as* — `deleteAccount` (`api/client.ts`) ends every
 * session belonging to it server-side, and `onSignedOut` (the same prop
 * `components/SignedInChrome.tsx`'s own sign-out button already triggers,
 * threaded through `pages/Shell.tsx` unchanged) is what actually moves this
 * browser off a screen it can no longer read.
 */

import { useState } from 'react'

import { ApiError, deleteAccount } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { useModal } from '../components/modal/ModalProvider.js'
import {
  OrganizationList,
  type OrganizationListRow,
} from '../components/OrganizationList.js'
import { DeleteIcon } from '../icons.js'
import type { Route } from '../routing/route.js'

export interface AccountProps {
  account: AccountSummary
  activeOrganizationId: string
  onSwitchOrganization: (organizationId: string) => void
  /** WEB-41 — `routing/useRoute.ts`'s own `navigate`, threaded down the same way `pages/Shell.tsx` already threads it to every other screen it renders. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** WEB-57/WEB-58 — `App.tsx`'s own `refreshSession`, threaded through `pages/Shell.tsx` unchanged; passed straight to `OrganizationList` (this file's own module comment on why). */
  refreshAccount: () => Promise<AccountSummary | undefined>
  /** WEB-72/DATA-7 — `App.tsx`'s own sign-out adapter, threaded through `pages/Shell.tsx` unchanged (this file's own module comment on why deleting this account needs it). */
  onSignedOut: () => void
}

export function Account({
  account,
  activeOrganizationId,
  onSwitchOrganization,
  navigate,
  refreshAccount,
  onSignedOut,
}: AccountProps) {
  const { prompt } = useModal()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<ApiError | undefined>(
    undefined
  )

  // WEB-72/DATA-7 — deleting the account signed in as this browser: asks
  // first, naming the account and what deleting it means, gated on typing
  // its own email exactly (`account.email` — the same typed-name discipline
  // `components/CourseRows.tsx#handleDelete` already applies to a course).
  // Reversible for the deployment's retention window, then permanent.
  const handleDelete = async () => {
    const typed = await prompt({
      title: `Delete your account?`,
      description:
        'This deletes your account. It is reversible for a while, and permanent ' +
        'after that. You will be signed out immediately. Type your email to confirm.',
      label: 'Email',
      placeholder: account.email,
      confirmLabel: 'Delete account',
      destructive: true,
      validate: (value) =>
        value === account.email
          ? undefined
          : 'Type your email exactly to confirm.',
    })
    if (typed === undefined) return

    setDeleteError(undefined)
    setDeleting(true)
    try {
      await deleteAccount()
      onSignedOut()
    } catch (caught) {
      if (caught instanceof ApiError) setDeleteError(caught)
      else throw caught
    } finally {
      setDeleting(false)
    }
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

      {/* WEB-72 — the last section on the screen, visibly separated,
          holding this account's own delete and nothing else. The same
          `border-danger-600 bg-danger-50 text-danger-700` shape
          `components/ErrorMessage.tsx`/`pages/Usage.tsx` already give a
          danger-scale panel — this app defines no `danger-900`/`danger-200`
          shade (`style.css`'s own three-shade semantic scale). */}
      <section
        aria-label="Danger zone"
        className="flex flex-col gap-3 rounded-md border border-danger-600 bg-danger-50 p-4"
      >
        <h2 className="text-section-title font-semibold text-danger-700">
          Danger zone
        </h2>
        {deleteError && <ErrorMessage error={deleteError} />}
        <Button
          variant="destructive"
          icon={<DeleteIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleDelete()}
          disabled={deleting}
        >
          {deleting ? 'Deleting…' : 'Delete account'}
        </Button>
      </section>
    </div>
  )
}
