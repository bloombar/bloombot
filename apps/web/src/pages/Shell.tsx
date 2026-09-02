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
 *
 * LINK-10: which tabs this account even sees depends on its *relationship*
 * to the active organization, not only which organization is active — a
 * membership (administers or teaches there) gets every tab; a connected
 * person with no membership (a student, reachable in this organization only
 * because they proved an identity there — LINK-3) gets Chat alone. `isMember`
 * below decides this from `account.memberships`, and `effectiveTab` is what
 * every branch below actually renders — never `activeTab` directly — so a
 * tab selection left over from a previously active membership organization
 * can never leak a screen the server would refuse in this one.
 */

import { useState } from 'react'

import { ApiError, dispatchAction, signOut } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { AppShell } from '../components/AppShell.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { InstallButton } from '../components/InstallButton.js'
import { OrganizationSwitcher } from '../components/OrganizationSwitcher.js'
import {
  NavigationGuardProvider,
  useNavigationGuard,
} from '../hooks/navigation-guard.js'
import { SignOutIcon } from '../icons.js'
import { Chat } from './Chat.js'
import { ProjectsPanel } from './ProjectsPanel.js'
import { Transcripts } from './Transcripts.js'

export interface ShellProps {
  account: AccountSummary
  /** Set by `App.tsx` once `pages/DiscordCallback.tsx` reports a bound server — carries across the round trip through Discord's own consent screen (see that page's module comment). `undefined` until an install completes in this browser session; there is no route today to look up an organization's existing bindings (see `docs/DECISIONS.md`). */
  justInstalled?: { organizationId: string; serverId: string }
  onSignedOut: () => void
}

/**
 * WEB-16: every navigation this shell itself initiates — the nav row, the
 * home control, the organization switcher — routes through
 * `useNavigationGuard()`'s own `guardedNavigate`, so a dirty form nested
 * anywhere below (`pages/CourseEditor.tsx`, today's one example) gets a
 * chance to confirm before it loses anything. `NavigationGuardProvider`
 * wraps `ShellInner` rather than being read from within the same
 * component that provides it — a context's own provider and its readers
 * cannot be the same component.
 */
export function Shell(props: ShellProps) {
  return (
    <NavigationGuardProvider>
      <ShellInner {...props} />
    </NavigationGuardProvider>
  )
}

function ShellInner({ account, justInstalled, onSignedOut }: ShellProps) {
  const { guardedNavigate } = useNavigationGuard()
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
  // WEB-14: also this shell's own "home" — the header's home control
  // (`AppShell.tsx`) returns here.
  const [activeTab, setActiveTab] = useState<
    'discord' | 'projects' | 'chat' | 'transcripts'
  >('projects')

  // LINK-10: a membership (TEN-1's administrative relationship) is not the
  // same thing as a connected person (LINK-3's proof) — a student who has
  // connected into an institution's own organization administers nothing
  // there. `routes/actions.ts` refuses every dispatched action for a caller
  // with no membership, unconditionally, before it even looks up which
  // action was requested — Discord, Projects and Transcripts are all
  // reached through `dispatchAction`, so all three would always refuse for
  // this account in this organization. `routes/chat.ts` is the one screen
  // built not to need a membership at all — it authorizes on an active
  // enrolment instead (that file's own module comment). `isMember` mirrors
  // that server-side boundary here; the server's own refusal, not this
  // check, is what actually makes any of this safe (`docs/DECISIONS.md`
  // D-50) — this only decides what the panel *offers*.
  const isMember = account.memberships.some(
    (membership) => membership.organizationId === activeOrganizationId
  )
  // Chat is the only screen a connected-but-not-a-member account can reach
  // in this organization — forced here, rather than merely left out of
  // `navItems` below, so a stale `activeTab` (this shell's own state,
  // deliberately *not* reset on an organization switch — unlike
  // `ProjectsPanel`'s/`Chat`'s own `key={activeOrganizationId}` remount,
  // which resets what is fetched *inside* a tab, not which tab is active)
  // can never render Discord, Projects or Transcripts for an organization
  // where the server would refuse every one of them.
  const effectiveTab = isMember ? activeTab : 'chat'

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

  const chatNavItem = {
    key: 'chat',
    label: 'Chat',
    onClick: () => guardedNavigate(() => setActiveTab('chat')),
    active: effectiveTab === 'chat',
  }

  return (
    <AppShell
      onHome={() =>
        guardedNavigate(() => setActiveTab(isMember ? 'projects' : 'chat'))
      }
      // LINK-10: Discord, Projects and Transcripts are withheld outright for
      // a connected-but-not-a-member organization, not merely disabled or
      // left to fail once clicked — a control every click through it would
      // 404 against is worse offered than absent (this component's own
      // module comment has the fuller reasoning, and what was deliberately
      // erred toward).
      navItems={
        isMember
          ? [
              {
                key: 'discord',
                label: 'Discord',
                onClick: () => guardedNavigate(() => setActiveTab('discord')),
                active: effectiveTab === 'discord',
              },
              {
                key: 'projects',
                label: 'Projects',
                onClick: () => guardedNavigate(() => setActiveTab('projects')),
                active: effectiveTab === 'projects',
              },
              chatNavItem,
              {
                key: 'transcripts',
                label: 'Transcripts',
                onClick: () =>
                  guardedNavigate(() => setActiveTab('transcripts')),
                active: effectiveTab === 'transcripts',
              },
            ]
          : [chatNavItem]
      }
      headerEnd={
        <>
          <OrganizationSwitcher
            memberships={account.memberships}
            connectedOrganizations={account.connectedOrganizations}
            activeOrganizationId={activeOrganizationId}
            onChange={(organizationId) =>
              guardedNavigate(() => setActiveOrganizationId(organizationId))
            }
          />
          <Button
            variant="secondary"
            icon={<SignOutIcon aria-hidden="true" className="size-4" />}
            // WEB-16 rework — every other navigation this shell starts goes
            // through `guardedNavigate` (the nav row, the home control, the
            // organization switcher, just above); signing out is a
            // navigation too, and leaves the shell just as completely, so a
            // dirty course form two components down deserves the same
            // chance to confirm before it is lost that clicking any other
            // tab already gives it.
            onClick={() => guardedNavigate(() => void handleSignOut())}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </>
      }
    >
      {effectiveTab === 'discord' ? (
        <div className="flex flex-col gap-4">
          <h1 className="text-page-title font-semibold text-neutral-900">
            Discord
          </h1>
          <InstallButton
            organizationId={activeOrganizationId}
            {...(installedServerId ? { installedServerId } : {})}
            onRemove={() => void handleRemove()}
            removing={removing}
          />
          {error && <ErrorMessage error={error} />}
        </div>
      ) : effectiveTab === 'chat' ? (
        // WEB-10: a fresh `Chat` per organization switch, the same
        // `key={activeOrganizationId}` reasoning `ProjectsPanel` below
        // already holds itself to — a course selected in the previous
        // organization must not linger once a different one is active.
        <Chat
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
        />
      ) : effectiveTab === 'transcripts' ? (
        // ADMIN-1..3 — the same `key={activeOrganizationId}` reasoning
        // `Chat`/`ProjectsPanel` already hold themselves to: a project or
        // course selected in the previous organization must not linger
        // once a different one is active.
        <Transcripts
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
        />
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
    </AppShell>
  )
}
