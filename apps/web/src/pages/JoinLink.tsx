/**
 * `/join/:secret` (ENRL-8) — a course join link, redeemed bound to the
 * caller's own signed-in identity. Not `pages/RedeemLink.tsx`: that page
 * redeems AUTH-1's own *sign-in* link (`/sign-in/:token`) — a different
 * thing entirely — and overloading it here would mean a visitor who
 * follows the wrong kind of link gets whichever page's confusing message,
 * rather than the one that actually names what went wrong for the link
 * they hold.
 *
 * Signed out, this page asks the visitor to sign in first — the same
 * `SignIn` screen every other entry point uses (`pages/Connect.tsx`'s own
 * precedent for "a visit alone does nothing") — and stashes the secret
 * (`PENDING_JOIN_LINK_KEY`, `sessionStorage`) so a returning sign-in (an
 * emailed link, opened in the same tab or a fresh one) lands back on this
 * exact link rather than the ordinary shell (`App.tsx`'s own
 * `returnToShell`). A `sessionStorage` marker, not a `?next=` URL
 * parameter carried through the sign-in redirect: this app already has one
 * established, working device for "return here after signing in"
 * (`Connect.tsx`'s `PENDING_CONNECT_ORG_KEY`), and a second, differently-shaped
 * mechanism for the identical problem would be the inconsistency, not the
 * fix — see `docs/DECISIONS.md` for this slice's own record of the choice,
 * including why the same-origin-path validation a `?next=` URL parameter
 * would need does not apply here.
 *
 * Signed in, it redeems once, on mount — the same "opening the link is the
 * action" shape `RedeemLink.tsx` already uses for its own single-use
 * secret, including the same `redeemedSecretRef` guard against
 * `StrictMode`'s development-only double-invoke (that page's own module
 * comment has the full reasoning).
 */

import { useEffect, useRef, useState } from 'react'

import { ApiError, redeemCourseJoinLink } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { SignIn } from './SignIn.js'

/** Set the moment this page mounts signed out, and read back by `App.tsx`'s own `returnToShell` — the same round-trip-surviving device `pages/Connect.tsx`'s `PENDING_CONNECT_ORG_KEY` already uses for a sign-in redemption's own round trip. */
export const PENDING_JOIN_LINK_KEY = 'bloombot:pendingJoinLinkSecret'

export interface JoinLinkProps {
  secret: string
  account: AccountSummary | null
  onSignedIn: () => void
  /** Called once redemption succeeds — the parent (`App.tsx`) re-checks `/auth/me` and navigates to the shell, the same "this page does not decide what comes next" split `RedeemLink.tsx`'s own `onRedeemed` already draws. */
  onRedeemed: () => void
}

type State = { kind: 'pending' } | { kind: 'error'; error: ApiError }

export function JoinLink({
  secret,
  account,
  onSignedIn,
  onRedeemed,
}: JoinLinkProps) {
  const [state, setState] = useState<State>({ kind: 'pending' })
  // See this file's own module comment on why this mirrors
  // `RedeemLink.tsx`'s identical `redeemedTokenRef` guard.
  const redeemedSecretRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!account) {
      // Signed out: stash the secret and let `SignIn` (below) take over —
      // nothing is redeemed until an account actually exists to bind it
      // to.
      sessionStorage.setItem(PENDING_JOIN_LINK_KEY, secret)
      return
    }
    sessionStorage.removeItem(PENDING_JOIN_LINK_KEY)

    if (redeemedSecretRef.current === secret) return
    redeemedSecretRef.current = secret

    redeemCourseJoinLink(secret).then(onRedeemed, (caught: unknown) => {
      if (caught instanceof ApiError) setState({ kind: 'error', error: caught })
      else throw caught
    })
    // `account`/`secret` are the only inputs this effect depends on —
    // `onRedeemed` is a stable callback from `App.tsx`, not state this page
    // re-reads.
  }, [account, secret])

  if (!account) {
    return <SignIn onSignedIn={onSignedIn} />
  }

  if (state.kind === 'error') {
    return (
      <div className="mx-auto mt-16 max-w-sm">
        <ErrorMessage error={state.error} />
      </div>
    )
  }
  return (
    <p
      role="status"
      className="mx-auto mt-16 max-w-sm text-sm text-neutral-500"
    >
      Joining…
    </p>
  )
}
