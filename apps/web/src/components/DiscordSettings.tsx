/**
 * TEN-8/WEB-4/TEN-9 (WEB-69 rework round 2): the Organization settings
 * screen's own Discord tab — which servers this organization is actually
 * connected to (`discordServers.list`), Remove for each, and Install for
 * another.
 *
 * **Moved out of `pages/Shell.tsx` in this rework round.** The first round
 * of WEB-69 kept this fetch eager, in `Shell.tsx`, on the grounds that
 * duplicating or deleting the tested TEN-8 fix was worse than one
 * deliberate exception to "a tab's own contents load only once first
 * opened." The user's own final decision reverses that: this tab now
 * fetches exactly the way every other tab already does — on mount of
 * *this* component, which `pages/OrganizationSettings.tsx`'s own
 * `visitedTabs` only ever mounts once the Discord tab has actually been
 * opened. Every piece of state and every comment below is carried over
 * verbatim from `Shell.tsx`'s own former implementation; only where it
 * lives, and what triggers the fetch, changed.
 *
 * **Why an organization switch needs no extra "abort the stale fetch"
 * logic here, unlike the old `Shell.tsx` implementation's own
 * `discordFetchId` race guard for that specific case:**
 * `pages/OrganizationSettings.tsx` is mounted with `key={activeOrganizationId}`
 * by `pages/Shell.tsx` — switching organizations remounts the whole
 * settings screen from scratch, which unmounts this component outright
 * (aborting its own in-flight fetch through the same `stale` closure
 * flag every other fetch in this app already uses) rather than asking it
 * to reconcile a response against a *new* organization. A fresh `Discord`
 * tab, for the new organization, only starts fetching if and when that
 * tab is opened again — `docs/DECISIONS.md` records this as the "simplest
 * correct option" the brief for this round asked to be picked. The
 * `discordFetchId` ref below still guards the one race that *can* still
 * happen within a single mount: a same-session `discordServers.remove`
 * invalidating an already in-flight `discordServers.list` for the same
 * organization (its own comment, below).
 */

import { useEffect, useRef, useState } from 'react'

import { ApiError, dispatchAction, listDiscordServers } from '../api/client.js'
import { isActiveDiscordBinding } from '../api/types.js'
import type { DiscordServerBindingSummary } from '../api/types.js'
import { ErrorMessage } from './ErrorMessage.js'
import { DiscordServerRow, InstallButton } from './InstallButton.js'
import { LoadingStatus, SkeletonRow } from './Skeleton.js'

export interface DiscordSettingsProps {
  organizationId: string
  /** Set by `App.tsx` once `pages/DiscordCallback.tsx` reports a bound server — carries across the round trip through Discord's own consent screen (see that page's module comment). `undefined` until an install completes in this browser session — this is only the *immediate* signal; `discordBindingState` (this file's own module comment, TEN-8) is what this tab actually trusts once it has fetched. */
  justInstalled?: { organizationId: string; serverId: string }
}

/**
 * TEN-8: the three shapes fetching an organization's Discord binding can be
 * in, mirroring the loading/error handling this panel already gives
 * `Projects.tsx` (`refresh`'s own `refreshId` there) — `'loading'` must
 * never render as "not installed" (that is the exact bug being fixed, one
 * request away), and a failed lookup must say so rather than guess.
 */
type DiscordBindingState =
  | { status: 'loading' }
  // TEN-9 — every binding the organization has ever held (active or
  // removed, `discordServers.list`'s own shape — this tab narrows to
  // active-only itself, below, the same way it always has). Plural: an
  // organization can now hold more than one at once, and `installedServers`
  // (below) is what the render actually reads.
  | { status: 'ready'; bindings: DiscordServerBindingSummary[] }
  | { status: 'error'; error: ApiError }

export function DiscordSettings({
  organizationId,
  justInstalled,
}: DiscordSettingsProps) {
  // TEN-8: the server-truth read this file's own module comment describes —
  // starts `'loading'` on every mount, never defaults to "no binding," so a
  // render before the first `listDiscordServers` response cannot be
  // mistaken for "not installed."
  const [discordBindingState, setDiscordBindingState] =
    useState<DiscordBindingState>({ status: 'loading' })
  // TEN-8 rework (must-fix 1) — the `justInstalled` fallback below is
  // consulted on *every* `'loading'` state, not only the first — recorded
  // once, in `handleRemove`, and never cleared. TEN-9 — a `Set`, not a
  // single value: this session may remove more than one binding before a
  // fresh fetch settles.
  const [removedServerIds, setRemovedServerIds] = useState<Set<string>>(
    new Set()
  )
  // Tags each `listDiscordServers` call, the same `refreshId` shape
  // `pages/Projects.tsx#refresh` already uses — a successful `handleRemove`
  // can make an earlier, still-in-flight lookup stale within this one
  // mount (this file's own module comment on why an organization switch no
  // longer needs this guard to matter for *that* case).
  const discordFetchId = useRef(0)
  // TEN-9 — which binding's own Remove is in flight, not a single flag: two
  // rows render independently now, and only the one actually being removed
  // should show "Removing…"/disable itself.
  const [removingServerId, setRemovingServerId] = useState<string | undefined>(
    undefined
  )
  const [error, setError] = useState<ApiError | undefined>(undefined)

  // TEN-8: read the organization's actual Discord binding once, on this
  // tab's own mount — `pages/OrganizationSettings.tsx`'s own `visitedTabs`
  // is what decides when that mount actually happens (this file's own
  // module comment on why this no longer needs to run "before the tab is
  // even opened," unlike `Shell.tsx`'s own former implementation).
  useEffect(() => {
    let stale = false
    const fetchId = ++discordFetchId.current
    setDiscordBindingState({ status: 'loading' })
    listDiscordServers(organizationId).then(
      (bindings) => {
        if (stale || fetchId !== discordFetchId.current) return
        setDiscordBindingState({ status: 'ready', bindings })
      },
      (caught: unknown) => {
        if (stale || fetchId !== discordFetchId.current) return
        if (caught instanceof ApiError) {
          setDiscordBindingState({ status: 'error', error: caught })
        } else throw caught
      }
    )
    return () => {
      stale = true
    }
  }, [organizationId])

  // `discordBindingState` is the source of truth once it has resolved; while
  // it is still `'loading'`, `justInstalled` — known synchronously, no
  // request required — stands in for it, but only for the organization it
  // actually names and only when `handleRemove` has not already removed
  // that exact server this session (`removedServerIds`'s own comment).
  // Once the fetch resolves (`'ready'` or `'error'`), `justInstalled` is
  // not consulted again: a stale same-session signal must never outlive
  // the server-truth read that supersedes it. TEN-9 — plural, and narrowed
  // to *active* bindings here. WEB-68 — carries `serverName` through
  // rather than narrowing to just the id, so `DiscordServerRow` can name
  // the row; `justInstalled` never carries a name, so that fallback row is
  // `null` until the real fetch resolves.
  const installedServers: { serverId: string; serverName: string | null }[] =
    discordBindingState.status === 'ready'
      ? discordBindingState.bindings
          .filter(isActiveDiscordBinding)
          .map((binding) => ({
            serverId: binding.serverId,
            serverName: binding.serverName,
          }))
      : discordBindingState.status === 'loading' &&
          justInstalled?.organizationId === organizationId &&
          !removedServerIds.has(justInstalled.serverId)
        ? [{ serverId: justInstalled.serverId, serverName: null }]
        : []

  const handleRemove = async (serverId: string) => {
    setError(undefined)
    setRemovingServerId(serverId)
    try {
      // TEN-6 — an ordinary action, reached the same way any other action
      // in `@bloombot/actions`' catalog is (`api/client.ts#dispatchAction`'s
      // own comment on why this is not a bespoke route).
      await dispatchAction(organizationId, 'discordServers.remove', {
        serverId,
      })
      // Invalidates any lookup still in flight for this organization — see
      // `discordFetchId`'s own comment.
      discordFetchId.current++
      // TEN-9 — marks just this one binding removed, leaving every other
      // active binding (and any removed history already fetched) alone,
      // when the fetch had already resolved. While it had not yet, there
      // is nothing else known to preserve.
      setDiscordBindingState((current) =>
        current.status === 'ready'
          ? {
              status: 'ready',
              bindings: current.bindings.map((binding) =>
                binding.serverId === serverId
                  ? { ...binding, removedAt: Date.now() }
                  : binding
              ),
            }
          : { status: 'ready', bindings: [] }
      )
      // Records exactly which server id this session just removed —
      // `removedServerIds`'s own comment on why this component's own
      // lifetime (not only this immediate render) needs to keep seeing it.
      setRemovedServerIds((current) => new Set(current).add(serverId))
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setRemovingServerId(undefined)
    }
  }

  const loading =
    discordBindingState.status === 'loading' && installedServers.length === 0

  return (
    <div className="flex flex-col gap-4" data-testid="discord-settings-panel">
      <h1 className="text-page-title font-semibold text-neutral-900">
        Discord
      </h1>
      {loading ? (
        // TEN-8: the lookup is in flight and `justInstalled` did not
        // already answer for this organization — rendering `InstallButton`
        // here would default to "Install," the exact bug being fixed, only
        // momentary. WEB-45: shaped like the row this becomes once
        // resolved (`DiscordServerRow`, below).
        <div className="flex flex-col gap-2">
          <SkeletonRow />
          <LoadingStatus />
        </div>
      ) : discordBindingState.status === 'error' ? (
        // TEN-8: say the lookup failed rather than silently falling back
        // to "not installed," which would offer Install for a server that
        // may well still be bound.
        <ErrorMessage error={discordBindingState.error} />
      ) : (
        // TEN-9 — every active binding gets its own row (with its own
        // Remove), and installing another is always offered underneath —
        // an organization is no longer limited to a single Install/Remove
        // pair.
        <div className="flex flex-col gap-4">
          {installedServers.length > 0 && (
            <ul className="flex flex-col gap-2">
              {installedServers.map(({ serverId, serverName }) => (
                <li key={serverId}>
                  <DiscordServerRow
                    serverId={serverId}
                    serverName={serverName}
                    onRemove={() => void handleRemove(serverId)}
                    removing={removingServerId === serverId}
                  />
                </li>
              ))}
            </ul>
          )}
          {/* WEB-68 — labels itself "Install to another Discord server"
              once there is already at least one to add to. */}
          <InstallButton
            organizationId={organizationId}
            hasExistingServer={installedServers.length > 0}
          />
        </div>
      )}
      {error && <ErrorMessage error={error} />}
    </div>
  )
}
