/**
 * LINK-11/WEB-49 — the one place this app builds `AppShell`'s own
 * `navGroups`/`onHome`/`headerStart`/`headerEnd`/`drawerFooter` props from a
 * signed-in account. Before this slice, `pages/Shell.tsx` was the only
 * screen that ever rendered `AppShell` at all, and built those five props
 * inline from the organization it was acting in; every other signed-in
 * render — `pages/Connect.tsx`, `pages/Connected.tsx`, `pages/JoinLink.tsx`,
 * `pages/Invitation.tsx`, `pages/ConnectAssistant.tsx`, and the signed-in
 * `pages/NotFound.tsx` `App.tsx` renders directly — stood outside the shell
 * entirely, with no header, or a smaller one of their own
 * (`pages/Connect.tsx`'s former `BrandHeader`). This component is what both
 * now share, so the header is one implementation rather than two that can
 * drift apart.
 *
 * Two differences from `pages/Shell.tsx`'s own former inline construction,
 * both required for the standalone pages this now also serves:
 *
 *  - `activeOrganizationId` is optional. The organization a `/connect/:id`
 *    or `/connected/:id` address names is frequently one this account
 *    cannot reach yet (that is the whole point of connecting), so it must
 *    never be handed to `OrganizationSwitcher` — passing an unreachable id
 *    there would ask it to display an organization not in `memberships` or
 *    `connectedOrganizations`, which it was never built to do. Every
 *    standalone page instead resolves the account's own *default*
 *    organization (`account-default-organization.ts`'s own module comment
 *    on why that is the identical rule `App.tsx`'s `resolveHomeRoute`
 *    already uses, not a second one invented here) and passes that instead
 *    — or nothing at all, when the account has neither a membership nor a
 *    connected organization (defended against, not assumed, the same
 *    discipline `resolveHomeRoute` already holds itself to). This component
 *    renders the header and drawer with no organization switcher and no
 *    organization-scoped nav in that case, rather than inventing an id.
 *  - `activeTab` is optional too — `undefined` for every standalone page,
 *    none of which is one of `pages/Shell.tsx`'s own eight tabs, so nothing
 *    in the drawer is ever highlighted `aria-current` for them.
 *
 * `runAction` is `pages/Shell.tsx`'s own `guardedNavigate`
 * (`hooks/navigation-guard.tsx`), threaded through unchanged — every action
 * this component starts (a drawer item, the home control, an organization
 * switch, sign-out) still runs through it there, so a dirty form nested
 * anywhere below still gets its chance to confirm first, exactly as before
 * this extraction. The standalone pages pass nothing (the default below runs
 * the action immediately) — none of them nest a form this app asks anyone to
 * confirm leaving.
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { signOut } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { ProfileIcon, SignOutIcon } from '../icons.js'
import { routeForTab, type Route, type Tab } from '../routing/route.js'
import { AppShell, type AppShellHandle } from './AppShell.js'
import { Button } from './Button.js'
import { OrganizationSwitcher } from './OrganizationSwitcher.js'

export interface SignedInChromeProps {
  account: AccountSummary
  /** The organization this render is acting in — `undefined` when there is none to show at all (this file's own module comment on why). Explicitly `| undefined` rather than merely optional: this app's own `tsconfig` sets `exactOptionalPropertyTypes`, and every standalone page computes this from `resolveDefaultOrganization`, which returns `undefined` for the "no organization at all" case rather than omitting the property. */
  activeOrganizationId: string | undefined
  /** Whether `account` is a member of `activeOrganizationId` — ignored when that is `undefined`. Decides which nav items render, the identical `isMember` split `pages/Shell.tsx`'s own module comment already describes (LINK-10). */
  isMember: boolean
  /** Which of `pages/Shell.tsx`'s own eight tabs this render corresponds to, if any — highlighted `aria-current` in the drawer. */
  activeTab?: Tab
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** Wraps every action this chrome starts, the same shape `hooks/navigation-guard.tsx`'s own `guardedNavigate` already has — defaults to running the action immediately, for a standalone page with no dirty form anywhere below to protect. */
  runAction?: (action: () => void) => void
  /** Called once this control's own sign-out completes (successfully or not — `handleSignOut`'s own comment on why regardless) so the caller can re-check the session, the same job `pages/Shell.tsx`'s own `onSignedOut` prop already did. */
  onSignedOut: () => void
  children: ReactNode
}

/**
 * LINK-11 — the one rule for where switching organizations lands, generalised
 * from `pages/Shell.tsx`'s own former `changeActiveOrganization`: on the same
 * tab, under the new organization, when the current render corresponds to
 * one of the eight tabs that has a real per-organization counterpart
 * (`activeTab` defined and not `'account'`); otherwise — `'account'` itself,
 * or a standalone page with no tab at all — the target organization's own
 * default landing screen (Projects for a member, Chat otherwise, the same
 * split `App.tsx`'s `resolveHomeRoute` already makes for a fresh sign-in).
 * One rule rather than two: a standalone page switching organizations is not
 * a different kind of "no counterpart" than `/account` switching away
 * already was.
 */
function landingForOrganizationSwitch(
  activeTab: Tab | undefined,
  organizationId: string,
  account: AccountSummary
): Route {
  if (activeTab !== undefined && activeTab !== 'account') {
    return routeForTab(activeTab, organizationId)
  }
  const targetIsMember = account.memberships.some(
    (membership) => membership.organizationId === organizationId
  )
  return routeForTab(targetIsMember ? 'projects' : 'chat', organizationId)
}

export function SignedInChrome({
  account,
  activeOrganizationId,
  isMember,
  activeTab,
  navigate,
  runAction = (action) => action(),
  onSignedOut,
  children,
}: SignedInChromeProps) {
  const appShellRef = useRef<AppShellHandle>(null)
  const [signingOut, setSigningOut] = useState(false)

  // WEB-16/WEB-29 — the drawer only actually closes once the guarded action
  // it belongs to actually proceeds, not the instant it is clicked
  // (`components/AppShell.tsx`'s own `AppShellHandle` doc comment has the
  // full reasoning) — `runAction` wraps the navigation *and* the close
  // together, exactly as `pages/Shell.tsx`'s own former `navigateToTab` did.
  const navigateToTab = (tab: Tab) => {
    if (activeOrganizationId === undefined) return
    runAction(() => {
      navigate(routeForTab(tab, activeOrganizationId))
      appShellRef.current?.closeDrawer()
    })
  }

  const chatNavItem = {
    key: 'chat',
    label: 'Chat',
    onClick: () => navigateToTab('chat'),
    active: activeTab === 'chat',
  }
  const mcpNavItem = {
    key: 'mcp',
    label: 'MCP',
    onClick: () => navigateToTab('mcp'),
    active: activeTab === 'mcp',
  }
  const everydayGroup = {
    key: 'everyday',
    items: isMember
      ? [
          {
            key: 'projects',
            label: 'Projects',
            onClick: () => navigateToTab('projects'),
            active: activeTab === 'projects',
          },
          chatNavItem,
          mcpNavItem,
          {
            key: 'transcripts',
            label: 'Transcripts',
            onClick: () => navigateToTab('transcripts'),
            active: activeTab === 'transcripts',
          },
        ]
      : [chatNavItem, mcpNavItem],
  }
  const organizationGroup = {
    key: 'organization',
    label: 'Organization',
    items: [
      {
        key: 'discord',
        label: 'Discord',
        onClick: () => navigateToTab('discord'),
        active: activeTab === 'discord',
      },
      {
        key: 'team',
        label: 'Team',
        onClick: () => navigateToTab('team'),
        active: activeTab === 'team',
      },
      {
        key: 'usage',
        label: 'Usage',
        onClick: () => navigateToTab('usage'),
        active: activeTab === 'usage',
      },
      {
        key: 'jobs',
        label: 'Jobs',
        onClick: () => navigateToTab('jobs'),
        active: activeTab === 'jobs',
      },
    ],
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } catch {
      // A `catch` with nothing in it, not merely a `finally` — the identical
      // reasoning `pages/Shell.tsx`'s own former `handleSignOut` already
      // carried: a rejected `signOut()` must not become an unhandled
      // rejection, and `onSignedOut` below already triggers the caller's own
      // `/auth/me` re-check, the source of truth for whether the session
      // actually ended.
    } finally {
      setSigningOut(false)
      onSignedOut()
    }
  }

  return (
    <AppShell
      ref={appShellRef}
      onHome={() =>
        runAction(() =>
          navigate(
            activeOrganizationId === undefined
              ? { kind: 'home' }
              : routeForTab(
                  isMember ? 'projects' : 'chat',
                  activeOrganizationId
                )
          )
        )
      }
      navGroups={
        activeOrganizationId === undefined
          ? []
          : isMember
            ? [everydayGroup, organizationGroup]
            : [everydayGroup]
      }
      headerStart={
        activeOrganizationId === undefined ? undefined : (
          <OrganizationSwitcher
            memberships={account.memberships}
            connectedOrganizations={account.connectedOrganizations}
            activeOrganizationId={activeOrganizationId}
            onChange={(organizationId) =>
              runAction(() =>
                navigate(
                  landingForOrganizationSwitch(
                    activeTab,
                    organizationId,
                    account
                  )
                )
              )
            }
            navigate={(route, options) =>
              runAction(() => navigate(route, options))
            }
          />
        )
      }
      headerEnd={
        <Button
          variant="ghost"
          aria-label="Account settings"
          icon={<ProfileIcon aria-hidden="true" className="size-5" />}
          onClick={() => runAction(() => navigate({ kind: 'account' }))}
        />
      }
      drawerFooter={
        <Button
          variant="secondary"
          icon={<SignOutIcon aria-hidden="true" className="size-4" />}
          onClick={() => runAction(() => void handleSignOut())}
          disabled={signingOut}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
      }
    >
      {children}
    </AppShell>
  )
}
