/**
 * The whole panel, routed by `routing/route.ts` (WEB-32/WEB-34) — this file
 * parses `window.location.pathname` into a `Route` exactly once, through
 * `routing/useRoute.ts`'s own hook, and switches on `route.kind` throughout
 * rather than the raw pathname string comparisons this file used to hold
 * (the `routing/` module's own doc comments carry the "why no router
 * library" reasoning this file's module comment used to state itself).
 *
 *  - `route.kind === 'sign-in'` — an emailed link lands here
 *    (`pages/RedeemLink.tsx`).
 *  - `route.kind === 'discord-callback'` — Discord's own OAuth redirect
 *    lands here (`pages/DiscordCallback.tsx`), for either the install flow
 *    or LINK-7's connect flow (that page's own module comment on how it
 *    tells the two apart).
 *  - `route.kind === 'connect'` — LINK-1/LINK-2's own invitation address
 *    (`pages/Connect.tsx`); reachable signed in *or* signed out, unlike
 *    every other route below, since a Discord invitation cannot know which
 *    it will be.
 *  - `route.kind === 'join-link'` — ENRL-8's own course join link
 *    (`pages/JoinLink.tsx`); reachable signed in or signed out, for the
 *    identical reason `'connect'` is above — a course join link is shared
 *    with a whole class, most of whom have never signed in before.
 *  - `route.kind === 'invitation'` — ENRL-10's own membership invitation
 *    (`pages/Invitation.tsx`); reachable signed in or signed out, the same
 *    reason `'join-link'` is above — the account an invitation is addressed
 *    to may never have signed in before.
 *  - an `AdminRoute` (`routing/route.ts`) — ADMIN-4's console
 *    (`pages/Admin.tsx`), with WEB-33's own sub-addresses now real screens
 *    inside it (that page's own module comment has the breakdown);
 *    reachable by any signed-in account (deliberately *not* `/admin`,
 *    `apps/api`'s own mount for this screen's reads and writes — see
 *    `vite.config.ts`'s own comment on that path), with `routes/admin.ts`
 *    the one place AUTH-4 is actually enforced.
 *  - a `ShellRoute` (`routing/route.ts`) naming an organization or the
 *    account screen — the signed-in shell (`pages/Shell.tsx`), once this
 *    account's own accessibility to it is checked (below).
 *  - `route.kind === 'home'` — resolved, once the session is known, to the
 *    account's own canonical landing address and replaced (WEB-34) rather
 *    than rendered directly.
 *  - anything else, including a `ShellRoute` naming an organization this
 *    account cannot see — `pages/NotFound.tsx`, never an empty shell.
 *  - none of the above, while the session itself is still being decided —
 *    the loading/unreachable screens, unchanged by this slice, decided by
 *    `GET /auth/me` (WEB-2: the session itself, never anything this app
 *    stored).
 *
 * WEB-34: every entry point above `ShellRoute`/`'home'` still replaces the
 * current history entry rather than pushing a new one — none of them are
 * places a visitor should be able to navigate back into (a redeemed,
 * single-use sign-in link; a completed OAuth callback; the one-time
 * resolution of `/` itself). Every navigation `pages/Shell.tsx` and the
 * screens beneath it make is an ordinary push, reachable by the browser's
 * own back and forward buttons — `routing/useRoute.ts`'s own `navigate`
 * pushes by default and only replaces when told to.
 */

import { useCallback, useEffect, useState } from 'react'

import { ApiError, fetchMe } from './api/client.js'
import type { AccountSummary } from './api/types.js'
import { Button } from './components/Button.js'
import { Admin } from './pages/Admin.js'
import { Connect } from './pages/Connect.js'
import { DiscordCallback } from './pages/DiscordCallback.js'
import { Invitation } from './pages/Invitation.js'
import { JoinLink } from './pages/JoinLink.js'
import { NotFound } from './pages/NotFound.js'
import { RedeemLink } from './pages/RedeemLink.js'
import { Shell } from './pages/Shell.js'
import { SignIn } from './pages/SignIn.js'
import {
  isAdminRoute,
  isShellRoute,
  parseRoute,
  type Route,
} from './routing/route.js'
import { useRoute } from './routing/useRoute.js'

// AUTH-6: the same-origin check every destination this app is ever handed —
// whether from a redeemed sign-in token (`returnToShell`, below) or, in
// principle, anywhere else — must pass before this app navigates to it.
// `@bloombot/auth` exports the identical `isSameOriginPath` this mirrors
// (`tokens.ts`'s own doc comment has the full reasoning, including why a
// char-code loop stands in for embedding a literal control character in the
// regex below); duplicated rather than imported, since `apps/web` may only
// ever import `@bloombot/schemas` from the workspace (PLAT-2, this app's own
// boundary rule — `api/types.ts`'s own module comment states it). A small,
// deliberately duplicated pure function, the same trade `docs/DECISIONS.md`'s
// D-34 already chose for `repos/course-join-links.ts`'s own `hashSecret`.
function isSameOriginPath(value: string): boolean {
  if (!/^\/(?!\/|\\)/.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x20) return false
  }
  return true
}

type SessionState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; account: AccountSummary }
  // `fetchMe()` rejected outright — `apps/api` was unreachable
  // (`api/client.ts`'s own `network_error`) or answered with something this
  // app cannot make sense of. Distinct from `signed-out`: that is an answer
  // ("no session"), this is the absence of one (finding 3 of the WEB-1..6
  // rework — without this state, a rejected `fetchMe()` left `session` at
  // `loading` forever, an unhandled rejection and a permanent spinner).
  | { kind: 'unreachable' }

/**
 * WEB-34's own home resolution: `/` replaced, once the session is known,
 * with the account's canonical landing address — `/o/<active org>/projects`
 * for a member, `/o/<active org>/chat` for a connected-only person
 * (LINK-10's carve-out), mirroring `pages/Shell.tsx`'s own former
 * `effectiveTab` restriction one level up, at the address itself rather
 * than only at what renders under it.
 *
 * `joinedCourse`/`justInstalled` are consulted first, exactly as
 * `pages/Shell.tsx`'s own `activeOrganizationId` initializer did before
 * this slice — a just-redeemed join link picks its own organization *and*
 * course directly (WEB-25); a just-completed Discord install picks its own
 * organization (TEN-8), though never its own tab — an install still lands
 * on Projects, the ordinary default, exactly as it did before this slice.
 *
 * Falling back to `account.connectedOrganizations[0]` when there is no
 * membership at all is new in this slice, not carried over: the code this
 * replaces defaulted straight to `account.memberships[0]?.organizationId ?? ''`,
 * which named no real organization at all for a connected-only account with
 * no membership anywhere — survivable there only because `activeTab` was
 * component state nothing depended on being a real address. A canonical URL
 * cannot name `''`, so this slice's own judgement call (recorded in
 * `docs/DECISIONS.md`) is to fall back one step further for that one case.
 */
function resolveHomeRoute(
  account: AccountSummary,
  joinedCourse: { organizationId: string; courseId: string } | undefined,
  justInstalled: { organizationId: string } | undefined
): Route {
  const isMemberOf = (organizationId: string) =>
    account.memberships.some(
      (membership) => membership.organizationId === organizationId
    )
  const isConnectedTo = (organizationId: string) =>
    account.connectedOrganizations.some(
      (connection) => connection.organizationId === organizationId
    )

  if (
    joinedCourse &&
    (isMemberOf(joinedCourse.organizationId) ||
      isConnectedTo(joinedCourse.organizationId))
  ) {
    return {
      kind: 'chat',
      organizationId: joinedCourse.organizationId,
      courseId: joinedCourse.courseId,
    }
  }

  const organizationId =
    justInstalled && isMemberOf(justInstalled.organizationId)
      ? justInstalled.organizationId
      : (account.memberships[0]?.organizationId ??
        account.connectedOrganizations[0]?.organizationId ??
        '')

  // No membership and no connected organization at all — should not happen
  // (TEN-1 gives every account its own personal organization on first sign
  // in), but this app is written to defend against, not assume, that
  // (`pages/Chat.tsx`'s own `describeDeclineNotice` is the same discipline).
  // `/account` names no organization at all, so it is the one address this
  // account can always reach regardless.
  if (organizationId === '') return { kind: 'account' }

  return isMemberOf(organizationId)
    ? { kind: 'projects', organizationId }
    : { kind: 'chat', organizationId }
}

export function App() {
  const [session, setSession] = useState<SessionState>({ kind: 'loading' })
  const { route, navigate } = useRoute()
  const [justInstalled, setJustInstalled] = useState<
    { organizationId: string; serverId: string } | undefined
  >(undefined)
  // WEB-25 — set once `pages/JoinLink.tsx` reports a redeemed course join
  // link, the same "carried across this one remount" shape `justInstalled`
  // (above) already uses for the Discord install round trip. `pages/Shell.tsx`
  // reads this to open directly on this organization and course, rather than
  // stranding a redeemer on whichever tab or screen this account happens to
  // default to.
  const [joinedCourse, setJoinedCourse] = useState<
    | { organizationId: string; courseId: string; alreadyEnrolled: boolean }
    | undefined
  >(undefined)

  // Returns the underlying promise (WEB-25's own need, below) — every
  // existing caller (`onSignedIn` handed straight to a child as a prop,
  // `useEffect`'s own call just below) already ignored the return value of
  // the plain `fetchMe().then(...)` this wraps, so exposing it here changes
  // nothing about how those callers behave; it only lets a *new* caller
  // sequence work after this has actually settled, rather than merely
  // fired.
  const refreshSession = useCallback(() => {
    return fetchMe().then(
      (response) => {
        setSession(
          response.account
            ? { kind: 'signed-in', account: response.account }
            : { kind: 'signed-out' }
        )
      },
      (caught: unknown) => {
        // A missing rejection handler here (finding 3 of the WEB-1..6
        // rework) meant an unreachable apps/api left `session` at `loading`
        // forever, with no message and no way to retry, and an unhandled
        // rejection besides — `api/client.ts`'s own `request` now always
        // rejects with an `ApiError` (never a bare `TypeError`), so this
        // narrows on it the same way every other screen does rather than
        // re-throwing.
        if (caught instanceof ApiError) setSession({ kind: 'unreachable' })
        else throw caught
      }
    )
  }, [])

  useEffect(() => {
    refreshSession()
  }, [refreshSession])

  // WEB-34: `/` itself is never rendered — once the session resolves, this
  // replaces it with the account's own canonical landing address
  // (`resolveHomeRoute`, above). Guarded on `route.kind === 'home'` so this
  // never fires again once the address has moved on to something else.
  useEffect(() => {
    if (session.kind !== 'signed-in' || route.kind !== 'home') return
    navigate(resolveHomeRoute(session.account, joinedCourse, justInstalled), {
      replace: true,
    })
  }, [session, route.kind, joinedCourse, justInstalled, navigate])

  // AUTH-6: a sign-in redemption (an emailed link, `RedeemLink`'s own
  // `onRedeemed`) used to always return to the shell unless a visitor who
  // arrived signed out at `/connect/:organizationId`, `/join/:secret` or
  // `/invitations/:secret` had stashed a `sessionStorage` marker for this
  // function to read back (`PENDING_CONNECT_ORG_KEY`/`PENDING_JOIN_LINK_KEY`/
  // `PENDING_INVITATION_KEY`) — which only ever worked while the whole round
  // trip stayed in the one browsing context that set it, and a sign-in link
  // arrives by email, which a mail client typically opens in a fresh one.
  // All three pages now carry their own destination on the sign-in token
  // itself instead (`pages/SignIn.tsx`'s own `destination` prop), so
  // `RedeemLink`'s `onRedeemed` hands it to this function directly — the
  // token's own answer, valid in whichever tab actually redeems it.
  // Re-validated here regardless of the server's own check: `apps/api`
  // already refuses a non-same-origin `destination` at request time
  // (`routes/auth.ts`), but "before anything navigates" is this app's own
  // last checkpoint before it does (`docs/DECISIONS.md` has this slice's
  // own record of the choice).
  //
  // WEB-32/WEB-34 rework: `destination` is a raw path string, exactly as it
  // always was (`pages/Connect.tsx`/`pages/JoinLink.tsx`/`pages/Invitation.tsx`
  // still hand-write their own `/connect/:id`/`/join/:secret`/
  // `/invitations/:secret` — the brief for this slice leaves those three
  // unchanged) — `parseRoute` is what turns it into a `Route` this app's own
  // router can navigate to, rather than a second, parallel `window.history`
  // call living here.
  const returnToShell = useCallback(
    (destination?: string) => {
      if (destination && isSameOriginPath(destination)) {
        navigate(parseRoute(destination), { replace: true })
        refreshSession()
        return
      }
      navigate({ kind: 'home' }, { replace: true })
      refreshSession()
    },
    [navigate, refreshSession]
  )

  if (route.kind === 'sign-in') {
    return <RedeemLink token={route.token} onRedeemed={returnToShell} />
  }

  // LINK-6/7 rework, finding 8 — `onConnected` used to be `returnToShell`
  // itself, which reads `PENDING_CONNECT_ORG_KEY` from `sessionStorage` —
  // already removed by `DiscordCallback.tsx`'s own preview step, well
  // before confirm (and this callback) ever runs. That silently sent a
  // freshly connected student to the ordinary shell instead of back to
  // this same organization's own connect screen, exactly the outcome that
  // page's own doc comment says must not happen — and every existing test
  // stayed green, because none of them checked *where* a confirmed connect
  // actually landed. Fixed by navigating on the argument this callback
  // already receives, not a sessionStorage key that is gone by the time it
  // fires.
  if (route.kind === 'discord-callback') {
    return (
      <DiscordCallback
        search={window.location.search}
        account={session.kind === 'signed-in' ? session.account : undefined}
        onInstalled={(organizationId, serverId) => {
          setJustInstalled({ organizationId, serverId })
          returnToShell()
        }}
        onConnected={(organizationId) => {
          navigate({ kind: 'connect', organizationId }, { replace: true })
          refreshSession()
        }}
        onDone={returnToShell}
      />
    )
  }

  if (session.kind === 'loading') {
    return (
      <p className="p-6 text-sm text-neutral-500" role="status">
        Loading…
      </p>
    )
  }

  if (session.kind === 'unreachable') {
    return (
      <div className="flex flex-col items-start gap-3 p-6">
        <p role="alert" className="text-sm text-danger-700">
          Could not reach Bloombot. Check your connection and try again.
        </p>
        <Button variant="primary" onClick={refreshSession}>
          Try again
        </Button>
      </div>
    )
  }

  // LINK-1/LINK-2 — the invitation address, reachable whether or not this
  // browser already has a session: `Connect.tsx` itself renders `SignIn`
  // when `account` is `null`, so this app does not have to decide that here
  // the way it does for every other route below.
  if (route.kind === 'connect') {
    return (
      <Connect
        organizationId={route.organizationId}
        account={session.kind === 'signed-in' ? session.account : null}
        onSignedIn={refreshSession}
      />
    )
  }

  // ENRL-8 — a course join link, reachable whether or not this browser
  // already has a session: `JoinLink.tsx` itself renders `SignIn` when
  // `account` is `null`, the same split `Connect.tsx` already draws above.
  //
  // WEB-25 — `onRedeemed` is not `returnToShell` directly (unlike
  // `Invitation`'s own, below): a redemption resolves which organization and
  // course to open, not merely "go back to where this page was" — recorded
  // in `joinedCourse` (this file's own module comment on why that mirrors
  // `justInstalled`) and then handed to the shell the same way an install
  // does, navigating to the root path rather than staying on `/join/:secret`
  // (`RedeemLink`'s own single-use secret and `JoinLink`'s own
  // `redeemedSecretRef` guard mean nothing left here to redeem twice anyway
  // if this page were somehow revisited).
  //
  // `refreshSession()` runs — and is awaited — *before* the navigation to
  // `/`, not after: `resolveHomeRoute` (above) reads whatever
  // `account.connectedOrganizations` this render already has. The join-link
  // redemption that just produced `joinedCourse` is the very thing that adds
  // this organization to that list — reachable only once a *fresh*
  // `/auth/me` read reflects it. Firing both at once (this function's own
  // former shape) let a stale `session` resolve `/` before a fresh one
  // arrived, opening the panel on the account's own personal organization
  // regardless of what `joinedCourse` said. Reproduced end to end
  // (`e2e/join-link.spec.ts`) before this fix, not merely reasoned about —
  // the switcher showed the joined institution as an option but never
  // selected it.
  if (route.kind === 'join-link') {
    return (
      <JoinLink
        secret={route.secret}
        account={session.kind === 'signed-in' ? session.account : null}
        onSignedIn={refreshSession}
        onRedeemed={(result) => {
          setJoinedCourse(result)
          refreshSession().then(() => {
            navigate({ kind: 'home' }, { replace: true })
          })
        }}
      />
    )
  }

  // ENRL-10 — a membership invitation, reachable whether or not this
  // browser already has a session, the identical reason `'join-link'` is
  // above: `Invitation.tsx` itself renders `SignIn` when `account` is
  // `null`.
  if (route.kind === 'invitation') {
    return (
      <Invitation
        secret={route.secret}
        account={session.kind === 'signed-in' ? session.account : null}
        onSignedIn={refreshSession}
        onRedeemed={returnToShell}
      />
    )
  }

  if (session.kind === 'signed-in') {
    // ADMIN-4 — reached under `/platform-admin`, deliberately outside `Shell`'s
    // own organization-scoped nav (`Admin.tsx`'s own module comment has
    // why) and deliberately *not* `/admin`: `apps/api`'s own
    // `routes/admin.ts` is mounted at `/admin` (`vite.config.ts`'s own
    // proxy list), and a page path and a proxied API path can never share
    // one top-level segment — the same reason `/sign-in/:token` (a page)
    // and `/auth/redeem` (the API it posts to) already do not. Any
    // signed-in account may navigate here; `routes/admin.ts` is what
    // actually enforces AUTH-4 on every request this screen makes, so a
    // non-administrator who types the URL sees the same
    // `not_platform_administrator` refusal `ErrorMessage` already knows
    // how to say in words, not a client-side guess at who is allowed to
    // even try.
    //
    // WEB-33 — every screen inside the console (`pages/Admin.tsx`'s own
    // `route` prop) is now real, so this passes `route`/`navigate` straight
    // through rather than only `onBack`; `isAdminRoute` narrows the same
    // way `isShellRoute` does for `Shell`, just below.
    if (isAdminRoute(route)) {
      return <Admin route={route} navigate={navigate} onBack={returnToShell} />
    }

    // WEB-34: `/` resolves and replaces before this ever renders anything
    // (the effect above) — this is only the one render in between.
    if (route.kind === 'home') {
      return (
        <p className="p-6 text-sm text-neutral-500" role="status">
          Loading…
        </p>
      )
    }

    if (isShellRoute(route)) {
      // WEB-32 — an address naming an organization this account has no
      // relationship to at all (neither a membership nor a connected
      // identity) is exactly the "anything else... names something this
      // account cannot see" case the brief calls out: a not-found screen,
      // never a leak of whether the organization even exists.
      // `'account'` names no organization to check.
      if (
        route.kind !== 'account' &&
        !session.account.memberships.some(
          (membership) => membership.organizationId === route.organizationId
        ) &&
        !session.account.connectedOrganizations.some(
          (connection) => connection.organizationId === route.organizationId
        )
      ) {
        return (
          <NotFound
            onHome={() => navigate({ kind: 'home' }, { replace: true })}
          />
        )
      }
      return (
        <Shell
          account={session.account}
          route={route}
          navigate={navigate}
          {...(justInstalled ? { justInstalled } : {})}
          {...(joinedCourse ? { joinedCourse } : {})}
          onSignedOut={() => {
            setJustInstalled(undefined)
            setJoinedCourse(undefined)
            refreshSession()
          }}
        />
      )
    }

    // A truly unrecognised address (`routing/route.ts#parseRoute`'s own
    // `'not-found'`), or one of the signed-out-only kinds above reached
    // while signed in with no matching branch left to take (defended, not
    // assumed — `pages/Chat.tsx`'s own `describeDeclineNotice` holds
    // itself to the same discipline).
    return (
      <NotFound onHome={() => navigate({ kind: 'home' }, { replace: true })} />
    )
  }

  // WEB-34/AUTH-6 — a signed-out visitor who followed a bookmark or a
  // shared link is asked to sign in, and the address they came for rides
  // along on the issued token (`SignIn`'s own `destination` prop, exactly
  // as `Connect`/`JoinLink`/`Invitation` already use it), so redeeming the
  // emailed link lands them on that screen rather than on whatever
  // `resolveHomeRoute` would have picked. Re-checked against
  // `isSameOriginPath` here even though this value comes from this app's
  // own address bar and `apps/api` checks it again at request time: the
  // same "this app's own last checkpoint before it navigates" rule the
  // sign-in redemption path above already follows.
  const signedOutDestination = `${window.location.pathname}${window.location.search}`
  return (
    <SignIn
      onSignedIn={refreshSession}
      {...(route.kind !== 'home' && isSameOriginPath(signedOutDestination)
        ? { destination: signedOutDestination }
        : {})}
    />
  )
}
