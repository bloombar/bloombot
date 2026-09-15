/**
 * `/connected/:organizationId` (LINK-11) — where `App.tsx`'s `DiscordCallback`
 * lands the browser once a Discord connection is confirmed, replacing the
 * navigation that used to return to this same organization's own
 * `pages/Connect.tsx` form. Landing back on `Connect.tsx` re-offered
 * connecting Discord — already just done — and showed the "Connect an
 * assistant" section alongside a "Discord connected" status line, neither of
 * which belongs on a screen that exists only to confirm what just happened
 * (`App.tsx`'s own `onConnected` doc comment has the fuller history: the
 * organization this page names is frequently one this account cannot reach
 * yet, which is the entire point of connecting, so a confirmation naming it
 * directly — rather than the ordinary shell, which has nothing to show for
 * an organization this account is not a member of — is what a freshly
 * connected student actually needs).
 *
 * Reachable signed in *or* signed out, the identical reason
 * `pages/Connect.tsx` is (that page's own module comment): the destination
 * survives the sign-in round trip on the token itself (AUTH-6), not
 * `sessionStorage` — a signed-out arrival here is not expected in practice
 * (confirming a connect already requires a session), but this page follows
 * `Connect.tsx`'s own precedent exactly rather than assuming that can never
 * happen.
 *
 * LINK-11 rework, must-fix 4 — signed in, this page reads
 * `GET .../person-link/status` (`api/client.ts#getPersonLinkStatus`) before
 * ever claiming "Discord connected," the identical read `Connect.tsx`
 * already makes durable on every mount it reaches. Before this fix, this
 * page asserted the claim for whatever `organizationId` the URL happened to
 * name, for *every* arrival — not only the one `App.tsx#onConnected`
 * navigation this is actually true for, but also a signed-out visitor's
 * AUTH-6 sign-in round trip (this file's own module comment above), where a
 * stale or hand-typed `/connected/:id` address may name an organization
 * whose connection never happened, or one the account cannot even reach —
 * in which case the Chat/MCP links below would point straight into it.
 * `docs/DECISIONS.md`'s D-113 records the choice below (redirect to
 * `pages/Connect.tsx`) and why.
 */

import { useEffect, useState } from 'react'

import { resolveDefaultOrganization } from '../account-default-organization.js'
import { ApiError, getPersonLinkStatus } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { AppLink } from '../components/AppLink.js'
import { SignedInChrome } from '../components/SignedInChrome.js'
import { SignInHeader } from '../components/SignInHeader.js'
import { LoadingStatus, SkeletonLine } from '../components/Skeleton.js'
import type { Route } from '../routing/route.js'
import { SignIn } from './SignIn.js'

export interface ConnectedProps {
  organizationId: string
  account: AccountSummary | null
  onSignedIn: () => void
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

type VerificationState =
  { kind: 'checking' } | { kind: 'connected'; username?: string }

export function Connected({
  organizationId,
  account,
  onSignedIn,
  navigate,
}: ConnectedProps) {
  const [state, setState] = useState<VerificationState>({ kind: 'checking' })

  // LINK-11 rework, must-fix 4 (this file's own module comment) — verified
  // fresh on every mount this page reaches signed in, and again whenever
  // `organizationId` changes, the identical "the server is what actually
  // knows" discipline `Connect.tsx`'s own status effect follows. Unlike
  // that page, this one does not fail open to a button on a "not connected"
  // or a refused read — there is no button here at all, only a claim this
  // page exists to make, so anything short of a confirmed connection
  // redirects to `Connect.tsx` instead, which already knows how to offer
  // "Connect Discord" (or fail open to it on its own refused read).
  useEffect(() => {
    if (!account) return
    let cancelled = false
    setState({ kind: 'checking' })
    getPersonLinkStatus(organizationId).then(
      (response) => {
        if (cancelled) return
        if (response.discord.connected) {
          setState({
            kind: 'connected',
            ...(response.discord.username
              ? { username: response.discord.username }
              : {}),
          })
          return
        }
        navigate({ kind: 'connect', organizationId }, { replace: true })
      },
      (caught: unknown) => {
        if (cancelled) return
        if (caught instanceof ApiError) {
          navigate({ kind: 'connect', organizationId }, { replace: true })
          return
        }
        throw caught
      }
    )
    return () => {
      cancelled = true
    }
    // `account`/`organizationId` are the only inputs this effect depends on
    // — `navigate` is a stable prop from `App.tsx`, not state this page
    // re-reads (the same convention `JoinLink.tsx`'s own effect states for
    // `onRedeemed`).
  }, [account, organizationId])

  if (!account) {
    // AUTH-6 — `destination` is what carries this page's own address through
    // the sign-in round trip, the identical mechanism `pages/Connect.tsx`'s
    // own module comment already describes for its own address.
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
        <SignInHeader />
        <SignIn
          onSignedIn={onSignedIn}
          destination={`/connected/${organizationId}`}
        />
      </div>
    )
  }

  // LINK-11 — this page names no organization of its own to act in (unlike
  // `pages/Shell.tsx`, it is not organization-scoped); `SignedInChrome`'s own
  // module comment on why the header instead falls back to the account's
  // *default* organization, resolved by the identical rule `App.tsx`'s
  // `resolveHomeRoute` already uses.
  const defaultOrganization = resolveDefaultOrganization(account)

  return (
    <SignedInChrome
      account={account}
      activeOrganizationId={defaultOrganization?.organizationId}
      isMember={defaultOrganization?.isMember ?? false}
      navigate={navigate}
      onSignedOut={onSignedIn}
    >
      {state.kind === 'checking' ? (
        // A quiet loading state while the verification read resolves —
        // never claim "Discord connected" only to redirect away from it a
        // moment later (must-fix 4's own reasoning).
        <div className="mx-auto mt-16 flex max-w-sm flex-col gap-2">
          <SkeletonLine className="h-4 w-40" />
          <LoadingStatus />
        </div>
      ) : (
        <div className="mx-auto mt-16 flex max-w-sm flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-page-title font-semibold text-neutral-900">
              Discord connected
            </h1>
            <p className="text-sm text-neutral-700">
              You can message the bot in Discord now
              {state.username ? ` as ${state.username}` : ''}.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <AppLink
              to={{ kind: 'chat', organizationId }}
              navigate={navigate}
              className="text-sm font-medium text-neutral-900 hover:underline"
            >
              Go to Chat
            </AppLink>
            <AppLink
              to={{ kind: 'mcp', organizationId }}
              navigate={navigate}
              className="text-sm font-medium text-neutral-900 hover:underline"
            >
              Connect an assistant (MCP)
            </AppLink>
          </div>
        </div>
      )}
    </SignedInChrome>
  )
}
