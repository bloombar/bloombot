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
 * `SignIn` screen every other entry point uses — passing this exact page's
 * own path as `SignIn`'s `destination` prop (AUTH-6), so a returning sign-in
 * lands back on this exact invitation rather than the ordinary shell
 * (`App.tsx`'s own `returnToShell`), **regardless of which browsing context
 * redeems it**: the destination is carried on the sign-in token itself
 * (`@bloombot/auth`'s `tokens.ts`/`sign-in.ts`), not in `sessionStorage`.
 *
 * Rework, found in review — this page used to be the one entry point AUTH-6
 * left behind: it stashed a `PENDING_INVITATION_KEY` `sessionStorage`
 * marker instead, the exact same-tab-only device AUTH-6 retired
 * `PENDING_JOIN_LINK_KEY` for (that page's own module comment has the full
 * "a sign-in link arrives by email, and a mail client typically opens it in
 * a fresh tab, which has no marker to read" reasoning) — an invitation is
 * emailed the identical way a join link is, so it carried the identical
 * defect: an owner invites a colleague, the colleague opens the invitation
 * email in a new tab, signs in there, and lands on the plain shell with no
 * membership and no explanation, because the tab that set the marker was
 * never the one the sign-in link redeemed in. Moved onto the same
 * token-carried mechanism `JoinLink.tsx`/`Connect.tsx` already use, rather
 * than inventing a second fix for one defect — `docs/DECISIONS.md` has this
 * rework's own record.
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
    // Signed out: `SignIn` (below) takes over — nothing is redeemed until
    // an account actually exists to bind it to (the same split
    // `JoinLink.tsx`'s own identical effect draws).
    if (!account) return

    if (redeemedSecretRef.current === secret) return
    redeemedSecretRef.current = secret

    redeemMembershipInvitation(secret).then(onRedeemed, (caught: unknown) => {
      if (caught instanceof ApiError) setState({ kind: 'error', error: caught })
      else throw caught
    })
  }, [account, secret])

  if (!account) {
    return (
      <SignIn onSignedIn={onSignedIn} destination={`/invitations/${secret}`} />
    )
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
