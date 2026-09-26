/**
 * WEB-69/WEB-72/DATA-7: an organization's own delete control, extracted
 * out of `components/Team.tsx`'s own former "last section on the screen"
 * (that file's own module comment on why) into its own tab on
 * `pages/OrganizationSettings.tsx` — this slice's own decision
 * (`docs/DECISIONS.md`), last in the tab bar, since a destructive control
 * belongs at the end, not among the others.
 *
 * Nothing about the delete itself changed in this move: the typed-name
 * gate, the fallback navigation afterward, and resolving the *fresh*
 * account through `refreshAccount` rather than a stale prop are all copied
 * verbatim from `Team.tsx`'s own former `handleDelete` — see the inline
 * comments below, unchanged from there.
 *
 * **Owner-only, and never asks to be saved.** `isOwner` decides whether
 * this tab even exists at all — `pages/OrganizationSettings.tsx`'s own tab
 * bar withholds it outright for a non-owner, the same "withheld outright,
 * not merely disabled" reasoning every owner-only section in this app
 * already holds itself to — so this component does not defend against
 * `isOwner === false` itself; it is never mounted for that caller in the
 * first place. This tab has no per-tab dirty flag either (this slice's own
 * WEB-38 "each tab keeps its own record of unsaved changes" rule): the
 * typed-name gate lives inside `useModal().prompt`'s own dialog, not a form
 * field on this tab itself, so there is never anything here for a tab
 * switch or a leave to ask about.
 */

import { useState } from 'react'

import { ApiError, softDeleteOrganization } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { DeleteIcon } from '../icons.js'
import { routeForTab, type Route } from '../routing/route.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { useModal } from './modal/ModalProvider.js'

export interface DangerZoneProps {
  organizationId: string
  /** WEB-72/DATA-7 — this organization's own name, for the typed-name gate (`pages/Shell.tsx`'s own `activeOrganizationName`, resolved from `account.memberships` — nothing new is fetched). */
  organizationName: string
  /** WEB-72/DATA-7 — `pages/Shell.tsx`'s own `navigate`, threaded through unchanged: deleting the organization this screen is showing moves the caller off it, the same way `components/OrganizationList.tsx#handleLeave` already moves a caller off an organization they just left. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** WEB-72/DATA-7 — `App.tsx`'s own `refreshAccount` adapter, threaded through `pages/Shell.tsx` unchanged: re-reads `GET /auth/me` after the delete, the same "resolve the fresh account, not the stale prop" discipline `OrganizationList.tsx#handleLeave` already holds itself to for its own fallback destination. */
  refreshAccount: () => Promise<AccountSummary | undefined>
}

export function DangerZone({
  organizationId,
  organizationName,
  navigate,
  refreshAccount,
}: DangerZoneProps) {
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<ApiError | undefined>(
    undefined
  )
  const { prompt } = useModal()

  // WEB-72/DATA-7 — deleting the organization currently on screen: asks
  // first, naming the organization and what deleting it means, gated on
  // typing its own name exactly (`organizationName` — the same typed-name
  // discipline `components/CourseRows.tsx#handleDelete`/
  // `hooks/useProjectMenu.tsx` already apply to a course/project).
  // Reversible for the deployment's retention window, then permanent.
  const handleDelete = async () => {
    const typed = await prompt({
      title: `Delete ${organizationName}?`,
      description:
        `This deletes ${organizationName} — its projects, courses, people ` +
        'and conversations. It is reversible for a while, and permanent ' +
        `after that. Type the organization's name to confirm.`,
      label: 'Organization name',
      placeholder: organizationName,
      confirmLabel: 'Delete organization',
      destructive: true,
      validate: (value) =>
        value === organizationName
          ? undefined
          : 'Type the name exactly to confirm.',
    })
    if (typed === undefined) return

    setDeleteError(undefined)
    setDeleting(true)
    try {
      await softDeleteOrganization(organizationId)
      // The organization this screen was showing is now gone — the same
      // "must not strand the caller on the thing they just deleted"
      // reasoning `components/OrganizationList.tsx#handleLeave` already
      // holds itself to for the identical case, one level up (leaving
      // rather than deleting). Resolves the *fresh* account, not this
      // component's own stale props, the same "resolve afterward, not from
      // what was already in hand" discipline that function's own module
      // comment gives (code review round 2, must-fix 1): a membership
      // preferred over a connected-only relationship, `/account` when
      // neither is left.
      const freshAccount = await refreshAccount()
      // Belt and braces (review finding) — `organizationId` (the one this
      // screen just deleted) is excluded here regardless of what
      // `refreshAccount` came back with. `/auth/me` (`routes/auth.ts`)
      // already excludes a soft-deleted organization at the query (DATA-9),
      // so this should never actually match anything by the time this
      // runs — but this navigation must stay correct even against a stale
      // or slow-to-propagate response, not only a fast one.
      const remainingMemberships =
        freshAccount?.memberships.filter(
          (membership) => membership.organizationId !== organizationId
        ) ?? []
      const remainingConnected =
        freshAccount?.connectedOrganizations.filter(
          (connection) => connection.organizationId !== organizationId
        ) ?? []
      const fallback = remainingMemberships[0] ?? remainingConnected[0]
      navigate(
        fallback
          ? routeForTab(
              'role' in fallback ? 'projects' : 'chat',
              fallback.organizationId
            )
          : { kind: 'account' }
      )
    } catch (caught) {
      if (caught instanceof ApiError) setDeleteError(caught)
      else throw caught
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="danger-zone-panel">
      <h1 className="text-page-title font-semibold text-neutral-900">
        Danger zone
      </h1>
      <section
        aria-label="Danger zone"
        className="flex flex-col gap-3 rounded-md border border-danger-600 bg-danger-50 p-4"
      >
        <h2 className="text-lg font-semibold text-danger-700">
          Delete this organization
        </h2>
        {deleteError && <ErrorMessage error={deleteError} />}
        <Button
          variant="destructive"
          icon={<DeleteIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleDelete()}
          disabled={deleting}
        >
          {deleting ? 'Deleting…' : 'Delete organization'}
        </Button>
      </section>
    </div>
  )
}
