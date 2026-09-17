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
 *
 * WEB-57/WEB-58 — each row now also offers a kebab, built the exact same
 * way `components/CourseRows.tsx` already builds its own (that file's own
 * module comment: `KebabMenu.tsx` plus `useModal()`'s `confirm`/`prompt`,
 * no third pattern for a row-level menu in this app):
 *
 *  - an **owned** row (`role === 'owner'`) offers **Rename**, a `prompt()`
 *    dialog seeded with the organization's current name — a blank or
 *    whitespace-only name is refused in the dialog itself (`requireName`,
 *    below), the same discipline `pages/Projects.tsx#handleRename` already
 *    holds a project's own name to;
 *  - a **non-owner membership** row (`role` set, not `'owner'`) offers
 *    **Leave**, a `confirm()` dialog naming the organization before
 *    `memberships.leave` is ever dispatched;
 *  - a **connected-only** row (`role === undefined`) offers neither: there
 *    is no membership to leave and, having never administered this
 *    organization, no name of its own to rename. No menu renders for it at
 *    all, rather than one with nothing in it.
 *
 * Both operations dispatch, then **await** `refreshAccount` — `App.tsx`'s
 * own adapter over `refreshSession`, threaded down through
 * `pages/Account.tsx`/`pages/Organizations.tsx` rather than invented again
 * here (the brief's own "thread it rather than inventing a second one," and
 * D-121's invitation race the same discipline already exists to avoid) —
 * before this component does anything else, so the header, the drawer and
 * both lists all read the same fresh `GET /auth/me` rather than a stale one.
 *
 * Leaving the organization currently active (`activeOrganizationId`, only
 * ever set by `Account.tsx` — `Organizations.tsx`'s own arrival list names
 * none, this file's own module comment above) must not strand the shell
 * acting in an organization this account no longer belongs to. Code review
 * (round 2), must-fix 1 — `handleLeave` below used to pick a fallback from
 * this component's own `rows` prop, closed over at the moment the row's
 * kebab opened: two Leaves confirmed back to back (nothing here disables a
 * *different* row's own kebab while one is busy — `KebabMenu`'s own
 * `disabled` only ever guards the row it belongs to) left the second one
 * computing its fallback from an account that still, as far as its own
 * closure knew, included the organization the first had already left,
 * landing on `NotFound`. `refreshAccount` now resolves the fresh account
 * itself (`AccountSummary | undefined` — `undefined` only when the refresh
 * itself found this browser signed out or `apps/api` unreachable, `App.tsx`'s
 * own module comment on that adapter), and the fallback is built from that,
 * not from `rows` — a membership preferred over a connected organization,
 * the same order `App.tsx#resolveDefaultOrganization` already uses;
 * `/account`, the one address every account can always reach, when none is
 * left (`pages/Shell.tsx`'s own `rememberedOrganizationId` effect is what
 * actually corrects the header once nothing is left to switch to — this
 * file's own `navigate({ kind: 'account' })` call is a no-op when the
 * caller is already there, which `Account.tsx` always is; see that file's
 * own module comment, code review round 2 must-fix 3).
 */

import { useState } from 'react'

import {
  ApiError,
  leaveOrganization,
  renameOrganization,
} from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { EditIcon, SignOutIcon } from '../icons.js'
import type { Route } from '../routing/route.js'
import { routeForTab } from '../routing/route.js'
import { AppLink } from './AppLink.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { KebabMenu, type KebabMenuItem } from './KebabMenu.js'
import { useModal } from './modal/ModalProvider.js'

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
  /** `routing/useRoute.ts`'s own `navigate`, for each row's own name-link (WEB-41's device, unchanged by this extraction) and, since WEB-58, for `handleLeave`'s own move away from a just-left active organization (this file's own module comment). */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** The word on each row's own action button — `Account.tsx`'s "Switch" or `Organizations.tsx`'s "Choose" (this file's own module comment on why they differ). */
  actionLabel: string
  /** WEB-57/WEB-58 — re-reads `GET /auth/me` after a rename or a leave (this file's own module comment on why, and on why this is threaded rather than invented again here), resolving the fresh account itself — `handleLeave`'s own fallback destination is built from this, not from the stale `rows` prop (this file's own module comment, code review round 2 must-fix 1). `undefined` only when the refresh itself found this browser signed out or `apps/api` unreachable. */
  refreshAccount: () => Promise<AccountSummary | undefined>
}

/** A blank or whitespace-only name is refused the same way `pages/Projects.tsx#requireName` already refuses one for a project. */
function requireName(value: string): string | undefined {
  return value.trim().length === 0 ? 'Enter an organization name.' : undefined
}

/** The same membership-then-connected mapping `pages/Account.tsx`/`pages/Organizations.tsx` each build their own `rows` prop from — reused here so `handleLeave`'s own fallback (this file's own module comment, code review round 2 must-fix 1) reads the fresh account `refreshAccount` resolves the same way either caller would. */
function rowsFromAccount(account: AccountSummary): OrganizationListRow[] {
  return [
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
}

export function OrganizationList({
  rows,
  activeOrganizationId,
  onSelectOrganization,
  navigate,
  actionLabel,
  refreshAccount,
}: OrganizationListProps) {
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [busyOrganizationId, setBusyOrganizationId] = useState<
    string | undefined
  >(undefined)
  const { confirm, prompt } = useModal()

  // WEB-57 — owner-only, matching the server's own check
  // (`organizations.rename`'s `execute`): the server refuses regardless,
  // this only decides what the menu offers.
  const handleRename = async (row: OrganizationListRow) => {
    const name = await prompt({
      title: `Rename "${row.organizationName}"`,
      label: 'Organization name',
      initialValue: row.organizationName,
      confirmLabel: 'Rename',
      validate: requireName,
    })
    if (name === undefined) return
    setError(undefined)
    setBusyOrganizationId(row.organizationId)
    try {
      await renameOrganization(row.organizationId, name.trim())
      await refreshAccount()
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyOrganizationId(undefined)
    }
  }

  // WEB-58 — non-owner-membership-only, matching the server's own check
  // (`memberships.leave`'s `execute` refuses an owner outright); confirms,
  // naming the organization, before dispatching anything.
  const handleLeave = async (row: OrganizationListRow) => {
    const confirmed = await confirm({
      title: `Leave ${row.organizationName}?`,
      description: `You will lose access to ${row.organizationName} until an owner adds you again.`,
      confirmLabel: 'Leave',
      destructive: true,
    })
    if (!confirmed) return
    setError(undefined)
    setBusyOrganizationId(row.organizationId)
    try {
      await leaveOrganization(row.organizationId)
      const freshAccount = await refreshAccount()
      // This file's own module comment above — leaving the organization
      // currently active must not strand the shell there. Picked from the
      // *fresh* account `refreshAccount` just resolved, not from this
      // component's own `rows` prop (code review round 2 must-fix 1) — a
      // membership preferred over a connected-only relationship, the same
      // fallback order `App.tsx#resolveDefaultOrganization` already uses;
      // `/account`, the one address every account can always reach, when
      // none is left (or the refresh itself found this browser signed out
      // or `apps/api` unreachable — `freshAccount` is `undefined` then too,
      // the identical "nothing to fall back to" treatment).
      if (row.organizationId === activeOrganizationId) {
        const remaining = freshAccount
          ? rowsFromAccount(freshAccount).filter(
              (candidate) => candidate.organizationId !== row.organizationId
            )
          : []
        const fallback =
          remaining.find((candidate) => candidate.role !== undefined) ??
          remaining[0]
        navigate(
          fallback
            ? routeForTab(
                fallback.role !== undefined ? 'projects' : 'chat',
                fallback.organizationId
              )
            : { kind: 'account' }
        )
      }
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusyOrganizationId(undefined)
    }
  }

  return (
    <>
      {error && <ErrorMessage error={error} />}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const isActive = row.organizationId === activeOrganizationId
          const busy = busyOrganizationId === row.organizationId
          // WEB-57/WEB-58 — this file's own module comment above has the
          // full owner/non-owner/connected-only split; a connected-only row
          // (`role === undefined`) gets no items at all, and no kebab
          // renders for it below.
          const items: KebabMenuItem[] =
            row.role === 'owner'
              ? [
                  {
                    key: 'rename',
                    label: 'Rename',
                    icon: <EditIcon aria-hidden="true" className="size-4" />,
                    onSelect: () => void handleRename(row),
                  },
                ]
              : row.role !== undefined
                ? [
                    {
                      key: 'leave',
                      label: 'Leave',
                      icon: (
                        <SignOutIcon aria-hidden="true" className="size-4" />
                      ),
                      destructive: true,
                      onSelect: () => void handleLeave(row),
                    },
                  ]
                : []
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
              <div className="flex items-center gap-2">
                {!isActive && (
                  <Button
                    variant="secondary"
                    // Code review (round 2), must-fix 2 — a leave in flight
                    // on this row disables its own kebab (`KebabMenu`'s own
                    // `disabled` below) but, before this fix, left this
                    // button clickable: switching into an organization
                    // whose membership was about to disappear landed on the
                    // signed-in not-found screen the instant the refresh
                    // caught up.
                    disabled={busy}
                    onClick={() => onSelectOrganization(row.organizationId)}
                  >
                    {actionLabel}
                  </Button>
                )}
                {items.length > 0 && (
                  <KebabMenu
                    label={`Actions for "${row.organizationName}"`}
                    items={items}
                    disabled={busy}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
