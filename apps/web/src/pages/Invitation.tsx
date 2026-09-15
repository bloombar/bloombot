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
 * the same `redeemedForRef` guard against `StrictMode`'s development-only
 * double-invoke.
 *
 * LINK-11 rework, must-fix 2 — `redeemedForRef` (and `state`) reset
 * whenever the *account* redeeming changes, not only the secret, the
 * identical defect and fix `JoinLink.tsx`'s own module comment already
 * describes: `SignedInChrome`'s sign-out control makes "sign out, sign back
 * in as someone else, same invitation link still open" reachable here too,
 * and the guard used to key on `secret` alone.
 *
 * ENRL-10's own text — "an invitation grants a role and nothing else: it is
 * not a sign-in, and redeeming one never creates an account or a session" —
 * is why this page, unlike `JoinLink.tsx`, cannot admit a visitor with no
 * account at all: `SignIn` here is the same screen every other entry point
 * renders, and an account that does not yet exist is created (or an
 * existing one signed into) exactly the way it always is, through that
 * screen's own ordinary sign-in flow — this page adds nothing to it.
 *
 * LINK-11: signed in, this page's own brief "Joining…"/error render sits
 * inside `SignedInChrome`, the identical treatment `JoinLink.tsx`'s own
 * module comment already describes for its own render, acting in the
 * account's own default organization rather than this page's own `secret`.
 */

import { useEffect, useRef, useState } from 'react'

import { resolveDefaultOrganization } from '../account-default-organization.js'
import { ApiError, redeemMembershipInvitation } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { SignedInChrome } from '../components/SignedInChrome.js'
import { SignInHeader } from '../components/SignInHeader.js'
import type { Route } from '../routing/route.js'
import { SignIn } from './SignIn.js'

export interface InvitationProps {
  secret: string
  account: AccountSummary | null
  onSignedIn: () => void
  /** Called once redemption succeeds — the parent (`App.tsx`) re-checks `/auth/me` and navigates to the shell, the same "this page does not decide what comes next" split `JoinLink.tsx`'s own `onRedeemed` already draws. */
  onRedeemed: () => void
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

type State = { kind: 'pending' } | { kind: 'error'; error: ApiError }

export function Invitation({
  secret,
  account,
  onSignedIn,
  onRedeemed,
  navigate,
}: InvitationProps) {
  const [state, setState] = useState<State>({ kind: 'pending' })
  // This file's own module comment (LINK-11 rework, must-fix 2) — keyed on
  // both the secret and the account redeeming it, `JoinLink.tsx`'s own
  // identical guard.
  const redeemedForRef = useRef<
    { secret: string; accountId: string } | undefined
  >(undefined)

  useEffect(() => {
    // Signed out: `SignIn` (below) takes over — nothing is redeemed until
    // an account actually exists to bind it to (the same split
    // `JoinLink.tsx`'s own identical effect draws).
    if (!account) return

    if (
      redeemedForRef.current?.secret === secret &&
      redeemedForRef.current.accountId === account.id
    ) {
      return
    }
    redeemedForRef.current = { secret, accountId: account.id }
    // A different account than whatever this page last redeemed for starts
    // from `'pending'` again — without this, a previous account's own
    // `'error'` state survived onto the next account's render.
    setState({ kind: 'pending' })

    redeemMembershipInvitation(secret).then(onRedeemed, (caught: unknown) => {
      if (caught instanceof ApiError) setState({ kind: 'error', error: caught })
      else throw caught
    })
  }, [account, secret])

  if (!account) {
    // MCP-11 — the header every sign-in surface shows, exactly once.
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
        <SignInHeader />
        <SignIn
          onSignedIn={onSignedIn}
          destination={`/invitations/${secret}`}
        />
      </div>
    )
  }

  // LINK-11 — signed in, this brief render sits inside the panel's own
  // chrome, acting in the account's default organization
  // (`JoinLink.tsx`'s own identical treatment).
  const defaultOrganization = resolveDefaultOrganization(account)

  return (
    <SignedInChrome
      account={account}
      activeOrganizationId={defaultOrganization?.organizationId}
      isMember={defaultOrganization?.isMember ?? false}
      navigate={navigate}
      onSignedOut={onSignedIn}
    >
      {state.kind === 'error' ? (
        <div className="mx-auto mt-16 max-w-sm">
          <ErrorMessage error={state.error} />
        </div>
      ) : (
        <p
          role="status"
          className="mx-auto mt-16 max-w-sm text-sm text-neutral-500"
        >
          Joining…
        </p>
      )}
    </SignedInChrome>
  )
}
