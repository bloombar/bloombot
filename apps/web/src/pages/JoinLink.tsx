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
 * precedent for "a visit alone does nothing") — passing this exact page's
 * own path as `SignIn`'s `destination` prop (AUTH-6), so a returning
 * sign-in lands back on this exact link rather than the ordinary shell
 * (`App.tsx`'s own `returnToShell`), **regardless of which browsing
 * context redeems it**: the destination is carried on the sign-in token
 * itself (`@bloombot/auth`'s `tokens.ts`/`sign-in.ts`), not in
 * `sessionStorage` — a `sessionStorage` marker used to do this job, and it
 * only ever worked while the whole round trip stayed in one tab, which it
 * usually does not: a sign-in link arrives by email, and a mail client
 * typically opens it in a fresh one, which has no marker to read
 * (`docs/DECISIONS.md` D-55 records that original choice; this file's own
 * entry there records what changed and why).
 *
 * Signed in, it redeems once, on mount — the same "opening the link is the
 * action" shape `RedeemLink.tsx` already uses for its own single-use
 * secret, including the same `redeemedForRef` guard against `StrictMode`'s
 * development-only double-invoke (that page's own module comment has the
 * full reasoning) — and hands the server's own answer (which organization,
 * which course, whether this account was already enrolled) up to
 * `onRedeemed` (WEB-25), rather than discarding it the way this page used
 * to.
 *
 * LINK-11 rework, must-fix 1 — `redeemedForRef` (and `state`) reset
 * whenever the *account* redeeming changes, not only the secret. This page
 * now carries `SignedInChrome`'s own sign-out control, which this render
 * did not offer before this slice — a visitor can sign out and back in as a
 * different account without ever leaving this page. The guard used to key
 * on `secret` alone, which is right for `StrictMode`'s double-invoke (the
 * same account, the same render) but wrong for "signed out, then signed
 * back in as someone else with the same link still open": the ref already
 * matched the unchanged `secret`, so the effect skipped redeeming
 * altogether and left the *previous* account's `state` (an error, or a
 * permanent "Joining…") on screen forever, for an account that never even
 * requested a redemption. Reproduced with a probe before this fix — account
 * A, then `null`, then account B, same `secret` — called
 * `redeemCourseJoinLink` once, not twice.
 *
 * LINK-11: signed in, this page's own brief "Joining…"/error render sits
 * inside `SignedInChrome` — the same chrome `pages/Shell.tsx` shows — acting
 * in the account's own default organization (`account-default-organization.ts`),
 * never this page's own `secret`, which names no organization at all until
 * redeemed.
 */

import { useEffect, useRef, useState } from 'react'

import { resolveDefaultOrganization } from '../account-default-organization.js'
import { ApiError, redeemCourseJoinLink } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { SignedInChrome } from '../components/SignedInChrome.js'
import { SignInHeader } from '../components/SignInHeader.js'
import type { Route } from '../routing/route.js'
import { SignIn } from './SignIn.js'

export interface JoinLinkProps {
  secret: string
  account: AccountSummary | null
  onSignedIn: () => void
  /** Called once redemption succeeds — fresh or already-enrolled (WEB-25's own "redeeming twice is a confirmation, not an error") — with what the server actually resolved. `App.tsx` re-checks `/auth/me` and opens the panel there, directly on this course, rather than this page deciding what comes next. */
  onRedeemed: (result: {
    organizationId: string
    courseId: string
    alreadyEnrolled: boolean
  }) => void
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

type State = { kind: 'pending' } | { kind: 'error'; error: ApiError }

export function JoinLink({
  secret,
  account,
  onSignedIn,
  onRedeemed,
  navigate,
}: JoinLinkProps) {
  const [state, setState] = useState<State>({ kind: 'pending' })
  // This file's own module comment (LINK-11 rework, must-fix 1) — keyed on
  // *both* the secret and the account redeeming it, since `SignedInChrome`
  // now makes "sign out, sign back in as someone else, same link still
  // open" a reachable sequence this guard has to tell apart from
  // `StrictMode`'s same-account double-invoke.
  const redeemedForRef = useRef<
    { secret: string; accountId: string } | undefined
  >(undefined)

  useEffect(() => {
    // Signed out: `SignIn` (below) takes over — nothing is redeemed until
    // an account actually exists to bind it to.
    if (!account) return

    if (
      redeemedForRef.current?.secret === secret &&
      redeemedForRef.current.accountId === account.id
    ) {
      return
    }
    redeemedForRef.current = { secret, accountId: account.id }
    // A different account than whatever this page last redeemed for (or
    // the first redemption attempt) starts from `'pending'` again — the
    // fix's own point: without this, a previous account's `'error'` state
    // survived onto the next account's render, since nothing here used to
    // reset it.
    setState({ kind: 'pending' })

    redeemCourseJoinLink(secret).then(onRedeemed, (caught: unknown) => {
      if (caught instanceof ApiError) setState({ kind: 'error', error: caught })
      else throw caught
    })
    // `account`/`secret` are the only inputs this effect depends on —
    // `onRedeemed` is a stable callback from `App.tsx`, not state this page
    // re-reads.
  }, [account, secret])

  if (!account) {
    // MCP-11 — the header every sign-in surface shows, exactly once.
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
        <SignInHeader />
        <SignIn onSignedIn={onSignedIn} destination={`/join/${secret}`} />
      </div>
    )
  }

  // LINK-11 — signed in, this brief render sits inside the panel's own
  // chrome, acting in the account's default organization (this file's own
  // module comment on why: this page's own `secret` names no organization
  // until it is redeemed).
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
