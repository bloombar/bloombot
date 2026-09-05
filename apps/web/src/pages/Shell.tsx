/**
 * WEB-32/WEB-34: this shell no longer owns `activeTab`/`activeOrganizationId`
 * as local state — both are derived from the `route` prop `App.tsx` threads
 * in, the parsed address the browser bar (and back/forward) actually shows.
 * `tabForRoute` (`routing/route.ts`) maps the current `route` to a `Tab`;
 * `activeOrganizationId`, below, reads `route.organizationId` where the
 * route carries one and falls back to `rememberedOrganizationId` only for
 * `'account'` (WEB-30), which deliberately names no organization at all —
 * see that state's own comment for why the header still needs one to show.
 * Every navigation this shell starts — a drawer item, the home control, an
 * organization switch — calls the `navigate` prop rather than a setter; the
 * rest of this module comment (below) describes what each tab shows and
 * why, unchanged by this slice.
 *
 * The signed-in shell: which organization the panel is acting in (WEB-3),
 * the Discord install button (WEB-4), and the projects and
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
import { DiscordServerRow, InstallButton } from '../components/InstallButton.js'
import { OrganizationSwitcher } from '../components/OrganizationSwitcher.js'
import { Team } from '../components/Team.js'
import {
  NavigationGuardProvider,
  useNavigationGuard,
} from '../hooks/navigation-guard.js'
import { ProfileIcon, SignOutIcon } from '../icons.js'
import {
  isProjectsRoute,
  routeForTab,
  tabForRoute,
  type Route,
  type ShellRoute,
} from '../routing/route.js'
import { Account } from './Account.js'
import { Chat } from './Chat.js'
import { Jobs } from './Jobs.js'
import { NotFound } from './NotFound.js'
import { ProjectsPanel } from './ProjectsPanel.js'
import { Transcripts } from './Transcripts.js'
import { Usage } from './Usage.js'

export interface ShellProps {
  account: AccountSummary
  /** WEB-32 — the address this shell is currently rendering; `pages/Shell.tsx` is the one place a `ShellRoute` is ever rendered, the same way it was the one place `activeTab`/`activeOrganizationId` local state used to live before this slice. */
  route: ShellRoute
  /** WEB-32/WEB-34 — `routing/useRoute.ts`'s own `navigate`, threaded down from `App.tsx`; every navigation this shell starts (a drawer item, the home control, an organization switch) calls this rather than setting local state. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** Set by `App.tsx` once `pages/DiscordCallback.tsx` reports a bound server — carries across the round trip through Discord's own consent screen (see that page's module comment). `undefined` until an install completes in this browser session — this is only the *immediate* signal; `discordBindingState` (this file's own module comment, TEN-8) is what the panel actually trusts once it has fetched, via `api/client.ts#listDiscordServers`, so a reload or a second device shows the truth too. */
  justInstalled?: { organizationId: string; serverId: string }
  /** WEB-25 — set by `App.tsx` once `pages/JoinLink.tsx` reports a redeemed course join link (fresh or already-enrolled). `App.tsx`'s own `resolveHomeRoute` (WEB-34) is what actually picks this organization and opens straight to the Chat tab with this course already selected, by navigating there directly — this prop is only what this file reads to decide whether the join confirmation banner belongs on the `Chat` it renders (the `Chat` render, below). */
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
  // TEN-9 — every binding the organization has ever held (active or
  // removed, `discordServers.list`'s own shape — this panel narrows to
  // active-only itself, below, the same way it always has). Plural: an
  // organization can now hold more than one at once, and `installedServerIds`
  // (below) is what the render actually reads.
  | { status: 'ready'; bindings: DiscordServerBindingSummary[] }
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
  route,
  navigate,
  justInstalled,
  joinedCourse,
  onSignedOut,
}: ShellProps) {
  const { guardedNavigate } = useNavigationGuard()
  // WEB-32/WEB-34 — `route.organizationId` is the source of truth for every
  // route above except `'account'`, which deliberately names no
  // organization at all (WEB-30's own carve-out). The header
  // (`OrganizationSwitcher`, below) still needs *some* organization to show
  // as active while `/account` is open — remembered here, updated whenever
  // the route itself carries a real one, so switching to `/account` and
  // back leaves the header showing whichever organization was active
  // beforehand, not blank. `App.tsx`'s own `resolveHomeRoute` (WEB-34) is
  // what picks the very first organization this shell ever mounts on
  // (preferring `joinedCourse`'s or `justInstalled`'s, the same preference
  // this state's own initializer used to hold directly) — by the time this
  // component exists, `route` already names it.
  const [rememberedOrganizationId, setRememberedOrganizationId] = useState(
    () =>
      route.kind === 'account'
        ? (account.memberships[0]?.organizationId ??
          account.connectedOrganizations[0]?.organizationId ??
          '')
        : route.organizationId
  )
  useEffect(() => {
    if (route.kind !== 'account')
      setRememberedOrganizationId(route.organizationId)
  }, [route])
  const activeOrganizationId =
    route.kind === 'account' ? rememberedOrganizationId : route.organizationId
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
  // the one immediately after removing it. TEN-9 — a `Set`, not a single
  // value: this session may remove more than one binding before a fresh
  // fetch settles.
  const [removedServerIds, setRemovedServerIds] = useState<Set<string>>(
    new Set()
  )
  // Tags each `listDiscordServers` call, the same `refreshId` shape
  // `pages/Projects.tsx#refresh` already uses — an organization switch
  // (re-running the effect below) or a successful `handleRemove` can each
  // make an earlier, still-in-flight lookup stale; only the most recent
  // request is allowed to update state, so a slow response for the
  // *previous* organization (or for a binding this same click just removed)
  // cannot resurrect it.
  const discordFetchId = useRef(0)
  // TEN-9 — which binding's own Remove is in flight, not a single flag: two
  // rows render independently now, and only the one actually being removed
  // should show "Removing…"/disable itself.
  const [removingServerId, setRemovingServerId] = useState<string | undefined>(
    undefined
  )
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [signingOut, setSigningOut] = useState(false)
  // WEB-32/WEB-34 — derived from `route`, not this shell's own state
  // (`tabForRoute`'s own comment, `routing/route.ts`, has why every
  // `ProjectsRoute` variant collapses to `'projects'`). `App.tsx`'s own
  // `resolveHomeRoute` is what a fresh mount actually lands on — Projects
  // for a member, Chat (with `joinedCourse`'s own course already in the
  // address) for a redeemer or a connected-only account — the same product
  // reasoning `docs/DECISIONS.md` D-25 already recorded for the tab
  // default, now expressed as an address rather than a `useState` initial
  // value.
  const activeTab = tabForRoute(route)

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

  // WEB-32/WEB-34 — and once that substitution has happened, correct the
  // *address* to match the screen (review finding). Rendering Chat under a
  // `/o/:id/discord` address left the two disagreeing, and a reload or a
  // copied link reproduced the mismatch every time; replacing (never
  // pushing) puts the reader on the address that names what they are
  // actually looking at without adding a history entry they never asked
  // for. Nothing here decides *access* — `navGroups` still withholds the
  // organization group, and the server refuses these reads for a
  // non-member regardless.
  useEffect(() => {
    if (effectiveTab === activeTab) return
    navigate(
      { kind: 'chat', organizationId: activeOrganizationId },
      { replace: true }
    )
  }, [effectiveTab, activeTab, activeOrganizationId, navigate])

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
      setDiscordBindingState({ status: 'ready', bindings: [] })
      return
    }
    const fetchId = ++discordFetchId.current
    setDiscordBindingState({ status: 'loading' })
    listDiscordServers(activeOrganizationId).then(
      (bindings) => {
        if (fetchId !== discordFetchId.current) return
        setDiscordBindingState({ status: 'ready', bindings })
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
  // (`removedServerIds`'s own comment — a `'loading'` state can be *any*
  // organization switch, not only the first render, so this must hold every
  // time, not once). Once the fetch resolves (`'ready'` or `'error'`),
  // `justInstalled` is not consulted again: a stale same-session signal must
  // never outlive the server-truth read that supersedes it. TEN-9 — plural,
  // and narrowed to *active* bindings here (`discordServers.list` itself
  // still returns every binding this organization has ever held, active or
  // removed — `DiscordBindingState`'s own comment on why): every server id
  // the Discord screen actually renders a row for.
  const installedServerIds: string[] =
    discordBindingState.status === 'ready'
      ? discordBindingState.bindings
          .filter((binding) => binding.removedAt === null)
          .map((binding) => binding.serverId)
      : discordBindingState.status === 'loading' &&
          justInstalled?.organizationId === activeOrganizationId &&
          !removedServerIds.has(justInstalled.serverId)
        ? [justInstalled.serverId]
        : []

  const handleRemove = async (serverId: string) => {
    setError(undefined)
    setRemovingServerId(serverId)
    try {
      // TEN-6 — an ordinary action, reached the same way any other action
      // in `@bloombot/actions`' catalog is (`api/client.ts#dispatchAction`'s
      // own comment on why this is not a bespoke route).
      await dispatchAction(activeOrganizationId, 'discordServers.remove', {
        serverId,
      })
      // Invalidates any lookup still in flight for this organization — see
      // `discordFetchId`'s own comment — so a slow `listDiscordServers`
      // response that started before this remove cannot land afterward and
      // show the just-removed binding as installed again.
      discordFetchId.current++
      // TEN-9 — marks just this one binding removed, leaving every other
      // active binding (and any removed history already fetched) alone,
      // when the fetch had already resolved. While it had not yet (the
      // `justInstalled` fallback window — `installedServerIds`'s own
      // comment above), there is nothing else known to preserve: the only
      // binding this render could have offered a Remove for is the one just
      // removed, so this becomes an empty, resolved list, the same as the
      // single-binding era's own `{ status: 'ready', binding: undefined }`.
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
      // `removedServerIds`'s own comment on why a later organization switch,
      // not only this immediate render, needs to keep seeing it.
      setRemovedServerIds((current) => new Set(current).add(serverId))
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setRemovingServerId(undefined)
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
  // Every drawer item's own `onClick` — navigate to that tab's own landing
  // address, then close the drawer — wrapped in `guardedNavigate` (WEB-16)
  // so a dirty form elsewhere in the tree gets its chance to confirm before
  // either happens. `routeForTab` (`routing/route.ts`) is the inverse of
  // `tabForRoute` above: every tab besides Projects is exactly one address,
  // so this always lands on that tab's plain landing screen, not wherever a
  // deep link inside it (a course, a project) last pointed.
  const navigateToTab = (tab: ReturnType<typeof tabForRoute>) =>
    guardedNavigate(() => {
      navigate(routeForTab(tab, activeOrganizationId))
      appShellRef.current?.closeDrawer()
    })

  // WEB-28: `pages/Courses.tsx`'s own Chat button — navigates straight to
  // this course's own Chat address, routed through `guardedNavigate`
  // (WEB-16) like every other navigation this shell starts, the same as
  // `navigateToTab` above.
  const openChatForCourse = (courseId: string) =>
    guardedNavigate(() => {
      navigate({ kind: 'chat', organizationId: activeOrganizationId, courseId })
    })

  // WEB-32/WEB-34's own "switching organizations navigates to the same
  // screen kind under the new organization id, or to that organization's
  // landing screen where the current screen has no counterpart" rule.
  // `routeForTab(activeTab, ...)` already drops every id a `ProjectsRoute`/
  // `'chat'` route might carry (a project, a course) — those never belong
  // to more than one organization (TEN-2), so they have no counterpart to
  // carry across regardless of which tab they are under. `'account'` has no
  // organization-scoped counterpart at all — switching from there always
  // lands on the target organization's own landing screen, the same
  // membership-or-not choice `App.tsx`'s own `resolveHomeRoute` makes for a
  // fresh sign-in.
  const changeActiveOrganization = (organizationId: string) =>
    guardedNavigate(() => {
      if (activeTab === 'account') {
        const targetIsMember = account.memberships.some(
          (membership) => membership.organizationId === organizationId
        )
        navigate(
          routeForTab(targetIsMember ? 'projects' : 'chat', organizationId)
        )
        return
      }
      navigate(routeForTab(activeTab, organizationId))
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
        guardedNavigate(() =>
          navigate(
            routeForTab(isMember ? 'projects' : 'chat', activeOrganizationId)
          )
        )
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
          onClick={() => guardedNavigate(() => navigate({ kind: 'account' }))}
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
          installedServerIds.length === 0 ? (
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
            // TEN-9 — every active binding gets its own row (with its own
            // Remove), and installing another is always offered underneath
            // — an organization is no longer limited to the single
            // Install/Remove pair this screen used to be.
            <div className="flex flex-col gap-4">
              {installedServerIds.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {installedServerIds.map((serverId) => (
                    <li key={serverId}>
                      <DiscordServerRow
                        serverId={serverId}
                        onRemove={() => void handleRemove(serverId)}
                        removing={removingServerId === serverId}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <InstallButton organizationId={activeOrganizationId} />
            </div>
          )}
          {error && <ErrorMessage error={error} />}
        </div>
      ) : effectiveTab === 'chat' ? (
        // WEB-10: a fresh `Chat` per organization switch, the same
        // `key={activeOrganizationId}` reasoning `ProjectsPanel` below
        // already holds itself to — a course selected in the previous
        // organization must not linger once a different one is active.
        //
        // WEB-32/WEB-34 — the selected course is `route.courseId` itself,
        // not shell state: `route.kind !== 'chat'` here exactly when
        // `effectiveTab` forced Chat for a connected-but-not-a-member
        // account reaching a different organization-scoped address
        // (LINK-10, this file's own module comment) — there is no course id
        // to read in that case either, so `Chat` opens with none chosen,
        // the same as a bare `/o/:id/chat` visit. Selecting one in the
        // `<select>` navigates (`onSelectCourse`, below) rather than
        // setting local state, so the address bar and the "seed once"
        // WEB-25 behaviour both fall out of the same prop.
        //
        // WEB-25 — `joinConfirmation` is only ever passed through when the
        // route's own course *is* the one this redemption just joined — a
        // redeemer who has since picked a different course (which
        // navigates, updating `route.courseId`) stops seeing it, and
        // returning to the joined course's own address (by picking it
        // again, or by pressing back) shows it again — this component holds
        // no separate "already shown" flag, the identical tradeoff this
        // file's own report already recorded before this slice.
        <Chat
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
          {...(route.kind === 'chat' && route.courseId !== undefined
            ? { courseId: route.courseId }
            : {})}
          onSelectCourse={(courseId) =>
            navigate({
              kind: 'chat',
              organizationId: activeOrganizationId,
              courseId,
            })
          }
          // WEB-32/WEB-34 — where `Chat`'s own not-found screen sends a
          // reader whose address names a course they cannot chat in.
          onClearCourse={() =>
            navigate({ kind: 'chat', organizationId: activeOrganizationId })
          }
          {...(joinedCourse &&
          joinedCourse.organizationId === activeOrganizationId &&
          route.kind === 'chat' &&
          route.courseId === joinedCourse.courseId
            ? {
                joinConfirmation: {
                  alreadyEnrolled: joinedCourse.alreadyEnrolled,
                },
              }
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
        // (`onSwitchOrganization`, below) navigates away from `/account`
        // altogether now (WEB-32 — `changeActiveOrganization` moves to the
        // new organization's own screen), so there is no mid-switch remount
        // for a key to protect against in the first place.
        <Account
          account={account}
          activeOrganizationId={activeOrganizationId}
          onSwitchOrganization={(organizationId) =>
            changeActiveOrganization(organizationId)
          }
        />
      ) : isProjectsRoute(route) ? (
        // Finding 5 (WEB-7 rework): `key={activeOrganizationId}` forces a
        // fresh `ProjectsPanel` — and its own internal `view` state — on
        // every organization switch. Without it, a project (or course)
        // selected in the previous organization stayed selected, and
        // switching organizations re-issued `courses.list`/`courses.get`
        // for a project id that no longer belongs to the newly active
        // organization — a cross-tenant lookup TEN-2's own policy
        // correctly refuses, stranding the instructor on that refusal
        // with no way to clear it short of reloading the page.
        //
        // WEB-32 — `route` itself is now the source of which of the four
        // project/course screens is showing (`pages/ProjectsPanel.tsx`'s
        // own module comment); this branch is only reached when
        // `effectiveTab === 'projects'`, which — since `isMember` must be
        // true for that (LINK-10's own restriction, above) — only ever
        // happens for a `route` this guard already accepts.
        <ProjectsPanel
          key={activeOrganizationId}
          organizationId={activeOrganizationId}
          route={route}
          navigate={navigate}
          onOpenChat={(courseId) => openChatForCourse(courseId)}
        />
      ) : (
        // Defensive, not expected (this codebase's own "defended, not
        // assumed" discipline — `pages/Chat.tsx`'s own `describeDeclineNotice`
        // holds itself to the same standard): `tabForRoute` maps every
        // `ShellRoute` to a tab, and every branch above already covers every
        // tab but `'projects'`, which `isProjectsRoute` covers immediately
        // above — nothing should ever reach this branch.
        <NotFound
          onHome={() =>
            navigate(
              routeForTab(isMember ? 'projects' : 'chat', activeOrganizationId)
            )
          }
        />
      )}
    </AppShell>
  )
}
