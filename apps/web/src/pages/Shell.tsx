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
 * can never leak a screen the server would refuse in this one. **One
 * exception:** `'account'` (WEB-30) is permitted for a non-member too —
 * account settings names the *account*, not the organization, so a
 * connected-only person must be able to reach it, and to switch away from
 * there to an organization where they are a member (`effectiveTab`'s own
 * comment below has the precise carve-out).
 *
 * WEB-29: the drawer's own two groups — Projects/Chat/Transcripts (every
 * signed-in account) and Discord/Team/Usage/Jobs (organization members
 * only, divided by a visible separator) — are `navGroups`, below, not the
 * flat `navItems` list this file used to build; `isMember` decides whether
 * the second group is offered at all, the same "withheld outright, not
 * merely disabled" reasoning this file's own module comment already gives
 * for LINK-10.
 *
 * TEN-8/WEB-4: the Discord tab's own install state has two sources, not
 * one. `justInstalled` is the *immediate* signal — `App.tsx` sets it only
 * once `pages/DiscordCallback.tsx` reports a bound server in this same
 * browser session, so it is known synchronously, before any request, and
 * showing it right away is what keeps a fresh install from flashing
 * "Install" while `discordBindingState` below is still in flight. But it is
 * silent about everything else — a reload, a second device, an install from
 * a previous session — which is the defect an audit found (see
 * `docs/ROADMAP.md`'s "Audit — surfaces that were never built"):
 * `justInstalled` alone made "already installed" indistinguishable from
 * "not installed" for anyone who did not just install in this tab.
 * `discordBindingState` fetches `discordServers.list` (`api/client.ts#listDiscordServers`)
 * on mount and on every organization switch, and — once it resolves — is
 * the only thing either `installedServerId` or `handleRemove` below trust;
 * `justInstalled` is consulted only while that fetch is still `'loading'`.
 * That `'loading'` state recurs on every organization switch, not only the
 * first render, so `justInstalled`'s stand-in has two independent ways to go
 * stale, not one — a same-session `discordServers.remove` (guarded by
 * `removedServerId`, its own comment below) and a switch away from and back
 * to a different organization mid-fetch (guarded by `discordFetchId`, its
 * own comment below, for the response race; `removedServerId` again for
 * what the `'loading'` window itself renders).
 *
 * COST-3/COST-4: a fifth tab, Usage (`pages/Usage.tsx`) — an audit found
 * neither an instructor's own read of their courses' spend nor a way to
 * set the organization's spending cap ever reached this panel
 * (`docs/ROADMAP.md`'s "Audit — surfaces that were never built"), the same
 * class of gap TEN-8/WEB-4 above were found to have. `isOwner`, computed
 * once below from `account.memberships`, is what `Usage.tsx` uses to
 * decide whether it renders the cap-setting form at all — the server's own
 * check (`costLedger.setSpendingCap`, restricted to an owner) is what
 * actually enforces this; this only decides what the panel offers, the
 * same division `isMember` already draws for the other four tabs.
 *
 * ENRL-5: a sixth tab, Team (`components/Team.tsx`) — the same class of gap
 * again: `memberships.grant` had existed since TEN-1's own slice with no
 * caller outside a test, so an owner had no actual way to add a second
 * instructor or a teaching assistant (`docs/ROADMAP.md`'s own audit note).
 * `isOwner` is reused here exactly as `Usage.tsx` already takes it — the
 * grant form is owner-only, the same reasoning, the same server-side
 * enforcement doing the real work.
 *
 * JOB-2: a seventh tab, Jobs (`pages/Jobs.tsx`) — the same class of gap a
 * third time: `jobs.get` needs an id the caller already holds, and every
 * screen that reaches it only ever holds one for a job dispatched in the
 * current browser session, so a job that failed permanently in an earlier
 * one was invisible to everyone, forever (`docs/ROADMAP.md`'s own audit
 * note; `pages/Jobs.tsx`'s own module comment has the full account). Open
 * to any member, not only an owner — `isOwner` is not threaded through
 * here, unlike Usage/Team, because `jobs.list` itself carries no owner-only
 * restriction (that action's own descriptor).
 */

import { useEffect, useRef, useState } from 'react'

import {
  ApiError,
  dispatchAction,
  listDiscordServers,
  signOut,
} from '../api/client.js'
import type {
  AccountSummary,
  DiscordServerBindingSummary,
} from '../api/types.js'
import { AppShell, type AppShellHandle } from '../components/AppShell.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { InstallButton } from '../components/InstallButton.js'
import { OrganizationSwitcher } from '../components/OrganizationSwitcher.js'
import { Team } from '../components/Team.js'
import {
  NavigationGuardProvider,
  useNavigationGuard,
} from '../hooks/navigation-guard.js'
import { ProfileIcon, SignOutIcon } from '../icons.js'
import { Account } from './Account.js'
import { Chat } from './Chat.js'
import { Jobs } from './Jobs.js'
import { ProjectsPanel } from './ProjectsPanel.js'
import { Transcripts } from './Transcripts.js'
import { Usage } from './Usage.js'

export interface ShellProps {
  account: AccountSummary
  /** Set by `App.tsx` once `pages/DiscordCallback.tsx` reports a bound server — carries across the round trip through Discord's own consent screen (see that page's module comment). `undefined` until an install completes in this browser session — this is only the *immediate* signal; `discordBindingState` (this file's own module comment, TEN-8) is what the panel actually trusts once it has fetched, via `api/client.ts#listDiscordServers`, so a reload or a second device shows the truth too. */
  justInstalled?: { organizationId: string; serverId: string }
  /** WEB-25 — set by `App.tsx` once `pages/JoinLink.tsx` reports a redeemed course join link (fresh or already-enrolled), the same "carried across this one remount" shape `justInstalled` (above) already uses for the Discord install round trip. Prefers this organization for the initial active one and opens straight to the Chat tab with this course already selected (`activeOrganizationId`/`activeTab`'s own initializers, and the `Chat` render, below) — a redeemer's whole point in following the link was to ask this exact course something, not to land on Projects and have to find it themselves. */
  joinedCourse?: {
    organizationId: string
    courseId: string
    alreadyEnrolled: boolean
  }
  onSignedOut: () => void
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
  | { status: 'ready'; binding: DiscordServerBindingSummary | undefined }
  | { status: 'error'; error: ApiError }

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

function ShellInner({
  account,
  justInstalled,
  joinedCourse,
  onSignedOut,
}: ShellProps) {
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
  //
  // WEB-25 — `joinedCourse` is checked first: a course join link admits a
  // redeemer as a *connected person*, not necessarily a member (LINK-10), so
  // this also checks `connectedOrganizations`, unlike `justInstalled`'s own
  // membership-only check (an install can only ever target an organization
  // this account already administers).
  const [activeOrganizationId, setActiveOrganizationId] = useState(() => {
    if (
      joinedCourse &&
      (account.memberships.some(
        (membership) =>
          membership.organizationId === joinedCourse.organizationId
      ) ||
        account.connectedOrganizations.some(
          (connection) =>
            connection.organizationId === joinedCourse.organizationId
        ))
    ) {
      return joinedCourse.organizationId
    }
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
  // TEN-8: the server-truth read this file's own module comment describes —
  // starts `'loading'` on every mount, never defaults to "no binding," so a
  // render before the first `listDiscordServers` response cannot be
  // mistaken for "not installed."
  const [discordBindingState, setDiscordBindingState] =
    useState<DiscordBindingState>({ status: 'loading' })
  // TEN-8 rework (must-fix 1) — the `justInstalled` fallback below is
  // consulted on *every* `'loading'` state, not only the first: an
  // organization switch away and back re-runs the effect below, which sets
  // `discordBindingState` back to `'loading'` while the refetch is in
  // flight, and without this record `justInstalled` would answer for that
  // window too — resurrecting a binding this same session already removed,
  // with a live Remove button that then 404s (`discordServers.remove`'s own
  // policy correctly refuses a binding that is no longer active). Recorded
  // once, in `handleRemove`, and never cleared — `justInstalled` itself
  // never changes after mount (it is a prop, not state this component
  // updates), so once its own server id has been removed this session it
  // must never be offered again, from *any* organization switch, not only
  // the one immediately after removing it.
  const [removedServerId, setRemovedServerId] = useState<string | undefined>(
    undefined
  )
  // Tags each `listDiscordServers` call, the same `refreshId` shape
  // `pages/Projects.tsx#refresh` already uses — an organization switch
  // (re-running the effect below) or a successful `handleRemove` can each
  // make an earlier, still-in-flight lookup stale; only the most recent
  // request is allowed to update state, so a slow response for the
  // *previous* organization (or for a binding this same click just removed)
  // cannot resurrect it.
  const discordFetchId = useRef(0)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [signingOut, setSigningOut] = useState(false)
  // Defaults to 'projects' — the module comment above has the product
  // reasoning; `docs/DECISIONS.md` D-25 has the accounting of what that
  // default costs `tests/shell.test.tsx` (a handful of `listProjects`
  // mocks, added there rather than left implicit by defaulting elsewhere).
  // WEB-14: also this shell's own "home" — the header's home control
  // (`AppShell.tsx`) returns here.
  //
  // WEB-25 — `joinedCourse` overrides that default to `'chat'`: a redeemer
  // followed this link to ask a course something, not to see Projects.
  const [activeTab, setActiveTab] = useState<
    | 'discord'
    | 'projects'
    | 'chat'
    | 'transcripts'
    | 'usage'
    | 'team'
    | 'jobs'
    | 'account'
  >(() => (joinedCourse ? 'chat' : 'projects'))

  // WEB-28: which course a course row's own "Chat" button most recently
  // asked to open — `Chat` (`pages/Chat.tsx`) only reads its own
  // `initialCourseId` prop once, at mount (the same "seed once, never
  // override a value already chosen" shape it already holds for the
  // `<select>`). Held here, in shell state, rather than read continuously
  // inside `Chat` itself: the more surgical alternative would touch
  // WEB-25's own `initialCourseId` contract there for a case this slice
  // does not need to solve. No `key` extension is needed to make a second
  // request reach a fresh `Chat` mount, either — `Chat` already sits in a
  // ternary chain with every other tab (below), so reaching it a second
  // time by way of `pages/Courses.tsx` (nested inside `ProjectsPanel`, a
  // *different* branch of that same chain) always unmounts and remounts it
  // regardless of `key`; a round 1 review measured this directly by
  // reverting an earlier revision's `key={`${activeOrganizationId}:${chatCourseId ?? ''}`}`
  // back to `key={activeOrganizationId}` alone and finding the second-click
  // test below still green (`docs/DECISIONS.md` D-75 has the corrected
  // record).
  //
  // Round 1 rework (must-fix 1): this value used to survive an
  // organization switch untouched — nothing cleared it — so a course
  // requested in one organization could be read as `initialCourseId` after
  // switching to a different one whose own course list never contained it.
  // `changeActiveOrganization`, below, is the one place `activeOrganizationId`
  // is ever set (`OrganizationSwitcher`'s `onChange`, `Account`'s own
  // `onSwitchOrganization`) — clearing `chatCourseId` there, every time,
  // keeps the invariant this state depends on: whenever it is not
  // `undefined`, it always names a course in the *currently* active
  // organization.
  const [chatCourseId, setChatCourseId] = useState<string | undefined>(
    undefined
  )

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
  // COST-3: whether the caller's own membership *here* is `'owner'` — this
  // file's own module comment has why `Usage.tsx` uses this to decide
  // whether it offers the cap-setting form at all, rather than only the
  // read.
  const isOwner = account.memberships.some(
    (membership) =>
      membership.organizationId === activeOrganizationId &&
      membership.role === 'owner'
  )
  // Chat is the only screen a connected-but-not-a-member account can reach
  // in this organization — forced here, rather than merely left out of
  // `navGroups` below, so a stale `activeTab` (this shell's own state,
  // deliberately *not* reset on an organization switch — unlike
  // `ProjectsPanel`'s/`Chat`'s own `key={activeOrganizationId}` remount,
  // which resets what is fetched *inside* a tab, not which tab is active)
  // can never render Discord, Projects or Transcripts for an organization
  // where the server would refuse every one of them. `'account'` is the one
  // exception (WEB-30, this file's own module comment): it is not
  // organization-scoped at all, so a non-member reaching it is never a leak
  // the way any of the other tabs would be.
  const effectiveTab = isMember || activeTab === 'account' ? activeTab : 'chat'

  // TEN-8: read the organization's actual Discord binding on mount and on
  // every organization switch — `isMember` guards it the same way it guards
  // `navItems` below, since a caller with no membership would only have
  // `discordServers.list` refused (`routes/actions.ts`) and never sees the
  // Discord tab to render a result for anyway. Not scoped to `effectiveTab
  // === 'discord'`: fetching once per organization, before the tab is even
  // opened, is what keeps switching *into* Discord from itself needing a
  // round trip on top of the mount's.
  useEffect(() => {
    if (!isMember) {
      setDiscordBindingState({ status: 'ready', binding: undefined })
      return
    }
    const fetchId = ++discordFetchId.current
    setDiscordBindingState({ status: 'loading' })
    listDiscordServers(activeOrganizationId).then(
      (bindings) => {
        if (fetchId !== discordFetchId.current) return
        setDiscordBindingState({
          status: 'ready',
          binding: bindings.find((binding) => binding.removedAt === null),
        })
      },
      (caught: unknown) => {
        if (fetchId !== discordFetchId.current) return
        if (caught instanceof ApiError) {
          setDiscordBindingState({ status: 'error', error: caught })
        } else throw caught
      }
    )
  }, [activeOrganizationId, isMember])

  // `discordBindingState` is the source of truth once it has resolved; while
  // it is still `'loading'`, `justInstalled` — known synchronously, no
  // request required — stands in for it, but only for the organization it
  // actually names (this file's own module comment on why) and only when
  // `handleRemove` has not already removed that exact server this session
  // (`removedServerId`'s own comment — a `'loading'` state can be *any*
  // organization switch, not only the first render, so this must hold every
  // time, not once). Once the fetch resolves (`'ready'` or `'error'`),
  // `justInstalled` is not consulted again: a stale same-session signal must
  // never outlive the server-truth read that supersedes it.
  const installedServerId =
    discordBindingState.status === 'ready'
      ? discordBindingState.binding?.serverId
      : discordBindingState.status === 'loading' &&
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
      // Invalidates any lookup still in flight for this organization — see
      // `discordFetchId`'s own comment — so a slow `listDiscordServers`
      // response that started before this remove cannot land afterward and
      // show the just-removed binding as installed again.
      discordFetchId.current++
      setDiscordBindingState({ status: 'ready', binding: undefined })
      // Records exactly which server id this session just removed —
      // `removedServerId`'s own comment on why a later organization switch,
      // not only this immediate render, needs to keep seeing it.
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

  // WEB-16/WEB-29: a ref onto `AppShell`'s own drawer handle, so a nav
  // item's own click can close the drawer itself once its guarded
  // navigation actually proceeds, rather than `AppShell` closing it
  // unconditionally the instant the item is clicked — `AppShellHandle`'s
  // own doc comment (`components/AppShell.tsx`) has the full reasoning,
  // and why the difference is what `e2e/keyboard.spec.ts`'s own focus-
  // restoration assertion depends on.
  const appShellRef = useRef<AppShellHandle>(null)
  // Every drawer item's own `onClick` — set the tab, then close the drawer
  // — wrapped in `guardedNavigate` (WEB-16) so a dirty form elsewhere in
  // the tree gets its chance to confirm before either happens.
  const navigateToTab = (tab: typeof activeTab) =>
    guardedNavigate(() => {
      setActiveTab(tab)
      appShellRef.current?.closeDrawer()
    })

  // WEB-28: `pages/Courses.tsx`'s own Chat button — routed through
  // `guardedNavigate` (WEB-16) like every other navigation this shell
  // starts, the same as `navigateToTab` above.
  const openChatForCourse = (courseId: string) =>
    guardedNavigate(() => {
      setChatCourseId(courseId)
      setActiveTab('chat')
    })

  // Round 1 rework (must-fix 1): the one place `activeOrganizationId`
  // itself is ever set — `OrganizationSwitcher`'s own `onChange` and
  // `Account`'s own `onSwitchOrganization`, below, both call this rather
  // than `setActiveOrganizationId` directly, so a course a previous Chat
  // click asked for cannot outlive the organization it belongs to
  // (`chatCourseId`'s own comment above has the invariant this keeps).
  const changeActiveOrganization = (organizationId: string) =>
    guardedNavigate(() => {
      setActiveOrganizationId(organizationId)
      setChatCourseId(undefined)
    })

  // WEB-29: the "everyday" group — Projects, Chat, Transcripts — every
  // signed-in account gets, member or connected-only alike; Chat is the
  // only one of the three a connected-only account can actually reach
  // (`effectiveTab`, above), so it is the only one offered when `isMember`
  // is false, exactly as `navItems`' own ternary used to decide before this
  // slice.
  const chatNavItem = {
    key: 'chat',
    label: 'Chat',
    onClick: () => navigateToTab('chat'),
    active: effectiveTab === 'chat',
  }
  const everydayGroup = {
    key: 'everyday',
    items: isMember
      ? [
          {
            key: 'projects',
            label: 'Projects',
            onClick: () => navigateToTab('projects'),
            active: effectiveTab === 'projects',
          },
          chatNavItem,
          {
            key: 'transcripts',
            label: 'Transcripts',
            onClick: () => navigateToTab('transcripts'),
            active: effectiveTab === 'transcripts',
          },
        ]
      : [chatNavItem],
  }
  // WEB-29: the organization group — Discord, Team, Usage, Jobs — offered
  // only to a member, and divided from the everyday group above by a
  // visible separator (`AppShell.tsx`'s own `navGroups` rendering). LINK-10:
  // withheld outright for a connected-but-not-a-member organization, not
  // merely disabled or left to fail once clicked — a control every click
  // through it would 404 against is worse offered than absent (this
  // component's own module comment has the fuller reasoning, and what was
  // deliberately erred toward).
  const organizationGroup = {
    key: 'organization',
    label: 'Organization',
    items: [
      {
        key: 'discord',
        label: 'Discord',
        onClick: () => navigateToTab('discord'),
        active: effectiveTab === 'discord',
      },
      {
        key: 'team',
        label: 'Team',
        onClick: () => navigateToTab('team'),
        active: effectiveTab === 'team',
      },
      {
        key: 'usage',
        label: 'Usage',
        onClick: () => navigateToTab('usage'),
        active: effectiveTab === 'usage',
      },
      {
        key: 'jobs',
        label: 'Jobs',
        onClick: () => navigateToTab('jobs'),
        active: effectiveTab === 'jobs',
      },
    ],
  }

  return (
    <AppShell
      ref={appShellRef}
      onHome={() =>
        guardedNavigate(() => setActiveTab(isMember ? 'projects' : 'chat'))
      }
      navGroups={
        isMember ? [everydayGroup, organizationGroup] : [everydayGroup]
      }
      // WEB-30: the acting organization's name sits at the header's leading
      // edge, in the space the nav row vacated — every navigation it starts
      // still goes through `guardedNavigate` (WEB-16), unchanged from before
      // this slice.
      headerStart={
        <OrganizationSwitcher
          memberships={account.memberships}
          connectedOrganizations={account.connectedOrganizations}
          activeOrganizationId={activeOrganizationId}
          onChange={(organizationId) =>
            changeActiveOrganization(organizationId)
          }
        />
      }
      // WEB-30: the header's trailing edge holds the profile control alone
      // — the organization switcher moved to `headerStart`, sign-out moved
      // to the drawer's foot (`drawerFooter`, below).
      headerEnd={
        <Button
          variant="ghost"
          aria-label="Account settings"
          icon={<ProfileIcon aria-hidden="true" className="size-5" />}
          onClick={() => guardedNavigate(() => setActiveTab('account'))}
        />
      }
      drawerFooter={
        <Button
          variant="secondary"
          icon={<SignOutIcon aria-hidden="true" className="size-4" />}
          // WEB-16 rework — every other navigation this shell starts goes
          // through `guardedNavigate` (the drawer's own items, the home
          // control, the organization switcher, the profile control);
          // signing out is a navigation too, and leaves the shell just as
          // completely, so a dirty course form two components down deserves
          // the same chance to confirm before it is lost that clicking any
          // other tab already gives it.
          onClick={() => guardedNavigate(() => void handleSignOut())}
          disabled={signingOut}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
      }
    >
      {effectiveTab === 'discord' ? (
        <div className="flex flex-col gap-4">
          <h1 className="text-page-title font-semibold text-neutral-900">
            Discord
          </h1>
          {discordBindingState.status === 'loading' &&
          installedServerId === undefined ? (
            // TEN-8: the lookup is in flight and `justInstalled` did not
            // already answer for this organization — rendering
            // `InstallButton` here would default to "Install," the exact
            // bug being fixed, only momentary. `role="status"` matches
            // `Projects.tsx`'s own loading text (`pages/Projects.tsx`), the
            // same pattern this panel already uses for an async read.
            <p role="status" className="text-sm text-neutral-500">
              Loading…
            </p>
          ) : discordBindingState.status === 'error' ? (
            // TEN-8: say the lookup failed rather than silently falling
            // back to "not installed," which would offer Install for a
            // server that may well still be bound.
            <ErrorMessage error={discordBindingState.error} />
          ) : (
            <InstallButton
              organizationId={activeOrganizationId}
              {...(installedServerId ? { installedServerId } : {})}
              onRemove={() => void handleRemove()}
              removing={removing}
            />
          )}
          {error && <ErrorMessage error={error} />}
        </div>
      ) : effectiveTab === 'chat' ? (
        // WEB-10: a fresh `Chat` per organization switch, the same
        // `key={activeOrganizationId}` reasoning `ProjectsPanel` below
        // already holds itself to — a course selected in the previous
        // organization must not linger once a different one is active.
        // WEB-28's own second-Chat-click case needs no extra key: `Chat`
        // sits in this same ternary chain, so navigating away from it —
        // through `pages/Courses.tsx`, nested inside `ProjectsPanel`, a
        // different branch entirely — already unmounts it; the next click
        // reaches a fresh mount regardless (`chatCourseId`'s own comment,
        // above, has the round 1 finding this corrected).
        //
        // WEB-25 — `joinedCourse` is only ever passed through when it names
        // *this* active organization *and* no course row's own Chat button
        // has since asked for a different one (`chatCourseId === joinedCourse.courseId`)
        // — a redeemer who has since switched to a different one, then
        // back, sees the same confirmation again on return (this component
        // holds no separate "already shown" flag), which is accurate, if
        // not the tersest possible UI — see this slice's own report for why
        // that tradeoff was left as is. `chatCourseId`, when set, always
        // names a course in *this* organization (`changeActiveOrganization`
        // clears it on every switch), so this guard needs no separate
        // `activeOrganizationId` check of its own.
        <Chat
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
          {...(joinedCourse &&
          joinedCourse.organizationId === activeOrganizationId &&
          (chatCourseId === undefined || chatCourseId === joinedCourse.courseId)
            ? {
                initialCourseId: joinedCourse.courseId,
                joinConfirmation: {
                  alreadyEnrolled: joinedCourse.alreadyEnrolled,
                },
              }
            : chatCourseId
              ? { initialCourseId: chatCourseId }
              : {})}
        />
      ) : effectiveTab === 'transcripts' ? (
        // ADMIN-1..3 — the same `key={activeOrganizationId}` reasoning
        // `Chat`/`ProjectsPanel` already hold themselves to: a project or
        // course selected in the previous organization must not linger
        // once a different one is active. `isOwner` (ADMIN-2, this file's
        // own module comment) is the same shape Usage/Team already take,
        // one level below — this screen decides whether to fetch or render
        // the Access log section at all.
        <Transcripts
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
          isOwner={isOwner}
        />
      ) : effectiveTab === 'usage' ? (
        // COST-3/COST-4 — the same `key={activeOrganizationId}` reasoning
        // every other tab above already holds itself to, plus `isOwner`
        // (this file's own module comment) so `Usage.tsx` knows whether to
        // offer the cap-setting form at all.
        <Usage
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
          isOwner={isOwner}
        />
      ) : effectiveTab === 'team' ? (
        // ENRL-5 — the same `key={activeOrganizationId}` reasoning every
        // other tab above already holds itself to, plus `isOwner` (this
        // file's own module comment) so `Team.tsx` knows whether to offer
        // the grant form at all. `viewerAccountId` (ENRL-11) is what lets
        // that same screen tell the caller's own row apart from a peer's —
        // its own module comment has why that distinction decides whether a
        // revoke control is even offered.
        <Team
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
          isOwner={isOwner}
          viewerAccountId={account.id}
        />
      ) : effectiveTab === 'jobs' ? (
        // JOB-2 — the same `key={activeOrganizationId}` reasoning every
        // other tab above already holds itself to; no `isOwner`, unlike
        // Usage/Team (this file's own module comment on why `jobs.list`
        // needs none).
        <Jobs
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
        />
      ) : effectiveTab === 'account' ? (
        // WEB-30 — not organization-scoped (this file's own module comment
        // on why `effectiveTab` permits it for a non-member too), so unlike
        // every tab above it takes no `key={activeOrganizationId}`: an
        // organization switch made *from* this screen
        // (`onSwitchOrganization`, below) must not remount it out from under
        // itself mid-switch.
        <Account
          account={account}
          activeOrganizationId={activeOrganizationId}
          onSwitchOrganization={(organizationId) =>
            changeActiveOrganization(organizationId)
          }
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
          onOpenChat={(courseId) => openChatForCourse(courseId)}
        />
      )}
    </AppShell>
  )
}
