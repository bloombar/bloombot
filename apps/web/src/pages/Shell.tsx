/**
 * The signed-in shell: which organization the panel is acting in (WEB-3),
 * the Discord install button (WEB-4), and — this slice — the projects and
 * courses screens (WEB-7, WEB-8, WEB-9). The two live behind a tab rather
 * than both rendering at once — `ProjectsPanel` fetches on mount
 * (`projects.list`), and there is no reason to pay that request, or show
 * that much screen, until an instructor actually wants it (`activeTab`'s
 * own comment below has the accounting of what gating it costs
 * `tests/shell.test.tsx`).
 *
 * The *default* tab is Projects, though: it is what an instructor comes to
 * this panel for on nearly every visit once a server is installed, and
 * landing on the install button every reload, one click away from the
 * thing they actually came for, is worse than the few extra `listProjects`
 * mocks that default costs the test file (finding 10 of the WEB-7 rework;
 * `docs/DECISIONS.md` D-25 has the same accounting from the test side).
 */

import { useState } from 'react'

import { ApiError, dispatchAction, signOut } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { InstallButton } from '../components/InstallButton.js'
import { OrganizationSwitcher } from '../components/OrganizationSwitcher.js'
import { ProjectsPanel } from './ProjectsPanel.js'

export interface ShellProps {
  account: AccountSummary
  /** Set by `App.tsx` once `pages/DiscordCallback.tsx` reports a bound server — carries across the round trip through Discord's own consent screen (see that page's module comment). `undefined` until an install completes in this browser session; there is no route today to look up an organization's existing bindings (see `docs/DECISIONS.md`). */
  justInstalled?: { organizationId: string; serverId: string }
  onSignedOut: () => void
}

export function Shell({ account, justInstalled, onSignedOut }: ShellProps) {
  // WEB-3/WEB-4 — an install navigates the whole browser away to Discord and
  // back (`components/InstallButton.tsx`'s own module comment), so the
  // callback lands on a fresh mount of this component: `justInstalled` is a
  // prop, not state this component already had. Defaulting to
  // `memberships[0]` unconditionally left a successful install into any
  // *other* organization stranded — the switcher showed the first
  // membership while the API had bound the server to whichever organization
  // the install actually ran for. Preferring `justInstalled.organizationId`
  // (when the account really is a member of it — defensive against a value
  // this app did not itself just hand back) makes the panel open on the
  // organization the install belonged to, so `installedServerId` below
  // actually matches on the first render rather than only after a manual
  // switch.
  const [activeOrganizationId, setActiveOrganizationId] = useState(() => {
    if (
      justInstalled &&
      account.memberships.some(
        (membership) =>
          membership.organizationId === justInstalled.organizationId
      )
    ) {
      return justInstalled.organizationId
    }
    return account.memberships[0]?.organizationId ?? ''
  })
  const [removedServerId, setRemovedServerId] = useState<string | undefined>(
    undefined
  )
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [signingOut, setSigningOut] = useState(false)
  // Defaults to 'projects' — the module comment above has the product
  // reasoning; `docs/DECISIONS.md` D-25 has the accounting of what that
  // default costs `tests/shell.test.tsx` (a handful of `listProjects`
  // mocks, added there rather than left implicit by defaulting elsewhere).
  const [activeTab, setActiveTab] = useState<'discord' | 'projects'>('projects')

  const installedServerId =
    justInstalled?.organizationId === activeOrganizationId &&
    justInstalled.serverId !== removedServerId
      ? justInstalled.serverId
      : undefined

  const handleRemove = async () => {
    if (!installedServerId) return
    setError(undefined)
    setRemoving(true)
    try {
      // TEN-6 — an ordinary action, reached the same way any other action
      // in `@bloombot/actions`' catalog is (`api/client.ts#dispatchAction`'s
      // own comment on why this is not a bespoke route).
      await dispatchAction(activeOrganizationId, 'discordServers.remove', {
        serverId: installedServerId,
      })
      setRemovedServerId(installedServerId)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setRemoving(false)
    }
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } catch {
      // A `catch` with nothing in it, not merely a `finally` — without one,
      // a rejected `signOut()` (a network failure, `api/client.ts`'s own
      // `network_error`) propagated past `finally` and out of this
      // `async` function, and `<button onClick={() => void handleSignOut()}>`
      // above discards the returned promise rather than awaiting it, so the
      // rejection had nowhere to land but an unhandled rejection (finding 3
      // of the WEB-1..6 rework). Nothing to show for it here either way:
      // `onSignedOut` below already triggers `App.tsx`'s own `/auth/me`
      // re-check, the source of truth for whether the session actually
      // ended — if it did not, that re-check is what puts this account back
      // in the shell, not anything this component decides.
    } finally {
      // AUTH-3: sign-out revokes the session server-side even if this
      // request somehow fails to round-trip — the caller should not be
      // stuck signed in on this screen either way, so `onSignedOut` runs
      // regardless and `App.tsx`'s own `/auth/me` re-check is the source of
      // truth for whether the session actually ended.
      setSigningOut(false)
      onSignedOut()
    }
  }

  return (
    <div className="shell">
      <header>
        <OrganizationSwitcher
          memberships={account.memberships}
          activeOrganizationId={activeOrganizationId}
          onChange={setActiveOrganizationId}
        />
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>
      <nav>
        <button
          type="button"
          onClick={() => setActiveTab('discord')}
          aria-current={activeTab === 'discord'}
        >
          Discord
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('projects')}
          aria-current={activeTab === 'projects'}
        >
          Projects
        </button>
      </nav>
      <main>
        {activeTab === 'discord' ? (
          <>
            <InstallButton
              organizationId={activeOrganizationId}
              {...(installedServerId ? { installedServerId } : {})}
              onRemove={() => void handleRemove()}
              removing={removing}
            />
            {error && <ErrorMessage error={error} />}
          </>
        ) : (
          // Finding 5 (WEB-7 rework): `key={activeOrganizationId}` forces a
          // fresh `ProjectsPanel` — and its own internal `view` state — on
          // every organization switch. Without it, a project (or course)
          // selected in the previous organization stayed selected, and
          // switching organizations re-issued `courses.list`/`courses.get`
          // for a project id that no longer belongs to the newly active
          // organization — a cross-tenant lookup TEN-2's own policy
          // correctly refuses, stranding the instructor on that refusal
          // with no way to clear it short of reloading the page.
          <ProjectsPanel
            key={activeOrganizationId}
            organizationId={activeOrganizationId}
          />
        )}
      </main>
    </div>
  )
}
