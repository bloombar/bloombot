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
 */

import { AppLink } from '../components/AppLink.js'
import type { AccountSummary } from '../api/types.js'
import { SignInHeader } from '../components/SignInHeader.js'
import { SignedInChrome } from '../components/SignedInChrome.js'
import { resolveDefaultOrganization } from '../account-default-organization.js'
import type { Route } from '../routing/route.js'
import { SignIn } from './SignIn.js'

export interface ConnectedProps {
  organizationId: string
  account: AccountSummary | null
  onSignedIn: () => void
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

export function Connected({
  organizationId,
  account,
  onSignedIn,
  navigate,
}: ConnectedProps) {
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
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-page-title font-semibold text-neutral-900">
            Discord connected
          </h1>
          <p className="text-sm text-neutral-700">
            You can message the bot in Discord now.
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
    </SignedInChrome>
  )
}
