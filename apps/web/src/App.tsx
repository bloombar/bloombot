/**
 * The whole panel: several screens and no router library (the brief for
 * this slice is explicit that a shell this small does not need one) —
 * `App` reads `window.location.pathname` itself and switches on it.
 *
 *  - `/sign-in/:token` — an emailed link lands here (`pages/RedeemLink.tsx`).
 *  - `/discord/callback` — Discord's own OAuth redirect lands here
 *    (`pages/DiscordCallback.tsx`), for either the install flow or LINK-7's
 *    connect flow (that page's own module comment on how it tells the two
 *    apart).
 *  - `/connect/:organizationId` — LINK-1/LINK-2's own invitation address
 *    (`pages/Connect.tsx`); reachable signed in *or* signed out, unlike
 *    every other path below, since a Discord invitation cannot know which
 *    it will be.
 *  - `/join/:secret` — ENRL-8's own course join link (`pages/JoinLink.tsx`);
 *    reachable signed in or signed out, for the identical reason
 *    `/connect/:organizationId` is above — a course join link is shared
 *    with a whole class, most of whom have never signed in before.
 *  - `/invitations/:secret` — ENRL-10's own membership invitation
 *    (`pages/Invitation.tsx`); reachable signed in or signed out, the same
 *    reason `/join/:secret` is above — the account an invitation is
 *    addressed to may never have signed in before.
 *  - `/platform-admin` — ADMIN-4's console (`pages/Admin.tsx`); reachable
 *    by any signed-in account (deliberately *not* `/admin`, `apps/api`'s
 *    own mount for this screen's reads and writes — see this file's own
 *    comment on that path, below), with `routes/admin.ts` the one place
 *    AUTH-4 is actually enforced.
 *  - anything else — the signed-in shell (`pages/Shell.tsx`) or the
 *    sign-in screen (`pages/SignIn.tsx`), decided by `GET /auth/me`
 *    (WEB-2: the session itself, never anything this app stored).
 *
 * Every transition between them replaces the URL with `history.replaceState`
 * rather than pushing a new entry — none of these are places a visitor
 * should be able to navigate back into (a redeemed, single-use sign-in
 * link; a completed OAuth callback).
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
import { RedeemLink } from './pages/RedeemLink.js'
import { Shell } from './pages/Shell.js'
import { SignIn } from './pages/SignIn.js'

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

function goToRoot(): void {
  window.history.replaceState(null, '', '/')
}

export function App() {
  const [session, setSession] = useState<SessionState>({ kind: 'loading' })
  const [path, setPath] = useState(window.location.pathname)
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
  // token's own answer, valid in whichever tab actually redeems it. No
  // `sessionStorage` fallback is read here any more: every path that once
  // needed one now carries its own destination on the token (rework, found
  // in review — `Invitation.tsx`'s own `PENDING_INVITATION_KEY` was the one
  // of the three this app's own AUTH-6 slice left behind; `docs/DECISIONS.md`
  // has the fuller account). Re-validated here regardless of the server's
  // own check: `apps/api` already refuses a non-same-origin `destination` at
  // request time (`routes/auth.ts`), but "before anything navigates" is this
  // app's own last checkpoint before it does (`docs/DECISIONS.md` has this
  // slice's own record of the choice).
  //
  // `PENDING_CONNECT_ORG_KEY` (`Connect.tsx`) keeps its one remaining job —
  // the Discord OAuth round trip, a same-tab redirect this app itself
  // initiates (`window.location.assign`), never an emailed link a mail
  // client might open elsewhere — and is not read here at all: `onConnected`
  // (below) navigates on the argument `DiscordCallback` already hands it,
  // the same "stop reading state that might be gone by the time this fires"
  // fix that callback's own history already needed once (see this file's own
  // comment on it, below).
  const returnToShell = useCallback(
    (destination?: string) => {
      if (destination && isSameOriginPath(destination)) {
        window.history.replaceState(null, '', destination)
        setPath(destination)
        refreshSession()
        return
      }

      goToRoot()
      setPath('/')
      refreshSession()
    },
    [refreshSession]
  )

  const signInTokenMatch = /^\/sign-in\/([^/]+)$/.exec(path)
  if (signInTokenMatch) {
    const token = signInTokenMatch[1]
    if (token) {
      return <RedeemLink token={token} onRedeemed={returnToShell} />
    }
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
  if (path === '/discord/callback') {
    return (
      <DiscordCallback
        search={window.location.search}
        account={session.kind === 'signed-in' ? session.account : undefined}
        onInstalled={(organizationId, serverId) => {
          setJustInstalled({ organizationId, serverId })
          returnToShell()
        }}
        onConnected={(organizationId) => {
          const target = `/connect/${organizationId}`
          window.history.replaceState(null, '', target)
          setPath(target)
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
  // the way it does for every other path below.
  const connectMatch = /^\/connect\/([^/]+)$/.exec(path)
  if (connectMatch) {
    const organizationId = connectMatch[1]
    if (organizationId) {
      return (
        <Connect
          organizationId={organizationId}
          account={session.kind === 'signed-in' ? session.account : null}
          onSignedIn={refreshSession}
        />
      )
    }
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
  // `/`, not after: `pages/Shell.tsx`'s own `activeOrganizationId` is a
  // `useState` lazy initializer, which runs exactly once, on `ShellInner`'s
  // first mount, reading whatever `account.connectedOrganizations` this
  // render already has. The join-link redemption that just produced
  // `joinedCourse` is the very thing that adds this organization to that
  // list — reachable only once a *fresh* `/auth/me` read reflects it. Firing
  // both at once (this function's own former shape) let `path` reach `/`,
  // and `Shell` mount, off the *stale* `session` still on hand from before
  // redemption — no institution in `connectedOrganizations` yet — so the
  // panel opened on the account's own personal organization regardless of
  // what `joinedCourse` said, and never got a second chance: a later,
  // resolved `session` update does not retroactively re-run an initializer
  // that already ran. Reproduced end to end (`e2e/join-link.spec.ts`) before
  // this fix, not merely reasoned about — the switcher showed the joined
  // institution as an option but never selected it.
  const joinLinkMatch = /^\/join\/([^/]+)$/.exec(path)
  if (joinLinkMatch) {
    const secret = joinLinkMatch[1]
    if (secret) {
      return (
        <JoinLink
          secret={secret}
          account={session.kind === 'signed-in' ? session.account : null}
          onSignedIn={refreshSession}
          onRedeemed={(result) => {
            setJoinedCourse(result)
            refreshSession().then(() => {
              goToRoot()
              setPath('/')
            })
          }}
        />
      )
    }
  }

  // ENRL-10 — a membership invitation, reachable whether or not this
  // browser already has a session, the identical reason `/join/:secret` is
  // above: `Invitation.tsx` itself renders `SignIn` when `account` is
  // `null`.
  const invitationMatch = /^\/invitations\/([^/]+)$/.exec(path)
  if (invitationMatch) {
    const secret = invitationMatch[1]
    if (secret) {
      return (
        <Invitation
          secret={secret}
          account={session.kind === 'signed-in' ? session.account : null}
          onSignedIn={refreshSession}
          onRedeemed={returnToShell}
        />
      )
    }
  }

  if (session.kind === 'signed-in') {
    // ADMIN-4 — reached at `/platform-admin`, deliberately outside `Shell`'s
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
    if (path === '/platform-admin') {
      return <Admin onBack={returnToShell} />
    }
    return (
      <Shell
        account={session.account}
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

  return <SignIn onSignedIn={refreshSession} />
}
