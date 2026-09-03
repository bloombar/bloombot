/**
 * `/invitations/:secret` (ENRL-10) — a membership invitation, redeemed bound
 * to the caller's own signed-in identity. `pages/JoinLink.tsx` is this
 * page's own precedent, closely followed, including that `pages/RedeemLink.tsx`
 * is a different thing entirely (AUTH-1's own *sign-in* link, `/sign-in/:token`)
 * and overloading it here would mean a visitor who follows the wrong kind of
 * link gets whichever page's confusing message, rather than the one that
 * actually names what went wrong for the link they hold.
 *
 * Signed out, this page asks the visitor to sign in first — the same
 * `SignIn` screen every other entry point uses — and stashes the secret
 * (`PENDING_INVITATION_KEY`, `sessionStorage`) so a returning sign-in lands
 * back on this exact invitation rather than the ordinary shell (`App.tsx`'s
 * own `returnToShell`), the identical `sessionStorage`-marker device
 * `JoinLink.tsx`'s own `PENDING_JOIN_LINK_KEY` already uses (that page's own
 * module comment has the full reasoning, including why a `sessionStorage`
 * marker and not a `?next=` URL parameter).
 *
 * Signed in, it redeems once, on mount — the same "opening the link is the
 * action" shape `JoinLink.tsx`/`RedeemLink.tsx` both already use, including
 * the same `redeemedSecretRef` guard against `StrictMode`'s development-only
 * double-invoke.
 *
 * ENRL-10's own text — "an invitation grants a role and nothing else: it is
 * not a sign-in, and redeeming one never creates an account or a session" —
 * is why this page, unlike `JoinLink.tsx`, cannot admit a visitor with no
 * account at all: `SignIn` here is the same screen every other entry point
 * renders, and an account that does not yet exist is created (or an
 * existing one signed into) exactly the way it always is, through that
 * screen's own ordinary sign-in flow — this page adds nothing to it.
 */

import { useEffect, useRef, useState } from 'react'

import { ApiError, redeemMembershipInvitation } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { SignIn } from './SignIn.js'

/** Set the moment this page mounts signed out, and read back by `App.tsx`'s own `returnToShell` — the same round-trip-surviving device `pages/JoinLink.tsx`'s `PENDING_JOIN_LINK_KEY` already uses. */
export const PENDING_INVITATION_KEY = 'bloombot:pendingInvitationSecret'

export interface InvitationProps {
  secret: string
  account: AccountSummary | null
  onSignedIn: () => void
  /** Called once redemption succeeds — the parent (`App.tsx`) re-checks `/auth/me` and navigates to the shell, the same "this page does not decide what comes next" split `JoinLink.tsx`'s own `onRedeemed` already draws. */
  onRedeemed: () => void
}

type State = { kind: 'pending' } | { kind: 'error'; error: ApiError }

export function Invitation({
  secret,
  account,
  onSignedIn,
  onRedeemed,
}: InvitationProps) {
  const [state, setState] = useState<State>({ kind: 'pending' })
  const redeemedSecretRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!account) {
      sessionStorage.setItem(PENDING_INVITATION_KEY, secret)
      return
    }
    sessionStorage.removeItem(PENDING_INVITATION_KEY)

    if (redeemedSecretRef.current === secret) return
    redeemedSecretRef.current = secret

    redeemMembershipInvitation(secret).then(onRedeemed, (caught: unknown) => {
      if (caught instanceof ApiError) setState({ kind: 'error', error: caught })
      else throw caught
    })
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
