/**
 * The whole panel: three screens and no router library (the brief for this
 * slice is explicit that a shell this small does not need one) — `App`
 * reads `window.location.pathname` itself and switches on it.
 *
 *  - `/sign-in/:token` — an emailed link lands here (`pages/RedeemLink.tsx`).
 *  - `/discord/callback` — Discord's own OAuth redirect lands here
 *    (`pages/DiscordCallback.tsx`).
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
import { DiscordCallback } from './pages/DiscordCallback.js'
import { RedeemLink } from './pages/RedeemLink.js'
import { Shell } from './pages/Shell.js'
import { SignIn } from './pages/SignIn.js'

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

  const refreshSession = useCallback(() => {
    fetchMe().then(
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

  const returnToShell = useCallback(() => {
    goToRoot()
    setPath('/')
    refreshSession()
  }, [refreshSession])

  const signInTokenMatch = /^\/sign-in\/([^/]+)$/.exec(path)
  if (signInTokenMatch) {
    const token = signInTokenMatch[1]
    if (token) {
      return <RedeemLink token={token} onRedeemed={returnToShell} />
    }
  }

  if (path === '/discord/callback') {
    return (
      <DiscordCallback
        search={window.location.search}
        onInstalled={(organizationId, serverId) => {
          setJustInstalled({ organizationId, serverId })
          returnToShell()
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

  if (session.kind === 'signed-in') {
    return (
      <Shell
        account={session.account}
        {...(justInstalled ? { justInstalled } : {})}
        onSignedOut={() => {
          setJustInstalled(undefined)
          refreshSession()
        }}
      />
    )
  }

  return <SignIn onSignedIn={refreshSession} />
}
