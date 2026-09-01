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

import { fetchMe } from './api/client.js'
import type { AccountSummary } from './api/types.js'
import { DiscordCallback } from './pages/DiscordCallback.js'
import { RedeemLink } from './pages/RedeemLink.js'
import { Shell } from './pages/Shell.js'
import { SignIn } from './pages/SignIn.js'

type SessionState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; account: AccountSummary }

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
    fetchMe().then((response) => {
      setSession(
        response.account
          ? { kind: 'signed-in', account: response.account }
          : { kind: 'signed-out' }
      )
    })
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
    return <p>Loading…</p>
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
