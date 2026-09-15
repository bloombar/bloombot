/**
 * `/connect-assistant/:requestId` (MCP-11) — the address
 * `apps/mcp/src/oauth-provider.ts#authorize` redirects the browser to,
 * naming a pending authorization row (`@bloombot/auth`'s
 * `mcp-oauth.ts`) that `apps/mcp` itself has no session to decide.
 * `routing/route.ts`'s own module comment has why `requestId` rides in the
 * path rather than a query string.
 *
 * Replaces the plain, server-rendered HTML `apps/api/src/routes/mcp-oauth-consent.ts`
 * used to answer with directly — that route is now a JSON API this page
 * calls (`api/client.ts#getConnectAssistantRequest`/`decideConnectAssistantRequest`),
 * and this is the real page of the panel `docs/DECISIONS.md`'s MCP-7 entry
 * already recorded as the intended follow-up, once nothing else was
 * mid-edit on `apps/web`'s own routing.
 *
 * **Every disclosure the old HTML made, still made — this is the security
 * review's must-fix 2, not cosmetic** (`routes/mcp-oauth-consent.ts`'s own
 * module comment has the fuller account-takeover history): the client's
 * registered name (or the "no registered name" wording, never a reassuring
 * placeholder), that the assistant will act as the caller's whole Bloombot
 * account, in every organization they belong to, gaining no course access
 * beyond what the account already has, and the **host** of the redirect URI
 * the connection code will be sent to.
 *
 * Three states, driven entirely by what `GET /oauth/mcp/request` answers:
 *  - signed out — the panel's own `SignIn`, headlined for this specific
 *    connection and naming the client, with `destination` set to this exact
 *    page so a redeemed sign-in link returns here (`isSameOriginPath`
 *    accepts it, the identical mechanism `pages/JoinLink.tsx`/
 *    `pages/Connect.tsx` already use);
 *  - signed in — the consent screen, Allow/Deny;
 *  - unavailable — the API's single 404 `connection_request_unavailable`
 *    covers an unknown id, an expired one, and one already bound to a
 *    different account, indistinguishably (the same "no oracle" discipline
 *    every other single-use secret in this platform holds itself to) — so
 *    this page renders one message for all three, rather than guessing
 *    which actually happened. A `POST /oauth/mcp/decide` that itself 404s
 *    (the request expired or was consumed between load and click) lands
 *    here too, rather than in `decideError` next to buttons that can never
 *    succeed again.
 *
 * **Rework round 1, must-fix 2 — clickjacking, the fourth defence the
 * security review's must-fix 2 named, lost when this screen moved off
 * `apps/api`'s own server-rendered route.** `X-Frame-Options`/CSP
 * `frame-ancestors` on the JSON router (`routes/mcp-oauth-consent.ts`)
 * protect an XHR response, which nothing renders — the actual clickable
 * Allow button now lives on this page, served by nginx's SPA fallback, with
 * no framing header of its own, and `SameSite=Lax` still carries a signed-in
 * cookie into a same-site iframe. This component refuses to render anything
 * but a plain refusal whenever `window.top !== window.self` — checked before
 * the data effect even fires, so a framed load neither claims the pending
 * authorization nor renders a decision to harvest a click from. The header
 * `add_header X-Frame-Options ...`/`Content-Security-Policy: frame-ancestors
 * 'none'` for nginx's own `location /` block (`deploy/nginx/mcp.conf`,
 * `deploy/nginx/README.md`) is documented as a manual, defence-in-depth step
 * for the operator — this in-app check is the defence that actually ships,
 * since it needs no root on the droplet.
 *
 * LINK-11: `state.kind === 'consent'` renders inside `SignedInChrome`, the
 * same chrome `pages/Shell.tsx` shows, acting in the account's own default
 * organization — this page names no organization of its own at all. Every
 * other state renders the bare `SignInHeader` instead, `'framed'` unchanged
 * from before this slice (it renders regardless of session state at all,
 * deliberately does not fetch anything — this file's own module comment on
 * why — and the security review's clickjacking defence is out of this
 * slice's scope).
 *
 * LINK-11 rework, must-fix 3 — the chrome is keyed on `state.kind ===
 * 'consent'`, never on the `account` prop alone. `'consent'` is the one
 * state `GET /oauth/mcp/request` only ever answers `signedIn: true` into
 * (this file's own module comment on the three states it drives) — the
 * server's own truth, not this component's client-held `account`, which can
 * disagree with it: a session that expires between `App.tsx`'s last
 * `/auth/me` and this page's own fetch still holds a stale, truthy
 * `account` prop while the server answers `signedIn: false`, landing on
 * `'signed-out'`. Keying `withChrome` on `account` alone rendered the full
 * signed-in chrome — sign-out control included — around the sign-in form in
 * exactly that window; keying it on the rendered state instead means the
 * chrome only ever appears with the screen the server actually confirmed is
 * signed in.
 */

import { useEffect, useState } from 'react'

import { resolveDefaultOrganization } from '../account-default-organization.js'
import {
  ApiError,
  decideConnectAssistantRequest,
  getConnectAssistantRequest,
} from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { LoadingStatus, Skeleton } from '../components/Skeleton.js'
import { SignedInChrome } from '../components/SignedInChrome.js'
import { SignInHeader } from '../components/SignInHeader.js'
import type { Route } from '../routing/route.js'
import { SignIn } from './SignIn.js'

export interface ConnectAssistantProps {
  requestId: string
  account: AccountSummary | null
  onSignedIn: () => void
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

/** How a client that registered with no `client_name` is named — never a reassuring placeholder like "An assistant" (the security review's own finding, carried across from the retired server-rendered screen: that string read as legitimate regardless of who was actually asking). */
function clientLabel(clientName: string | undefined): string {
  return clientName ? clientName : 'An application with no registered name'
}

/** Rework round 1, must-fix 2 — `window.top` throws (a `SecurityError`) rather than reads as a different origin's `window` when the framing page is itself cross-origin, so a plain `!==` is not safe here. A cross-origin ancestor is exactly the case this exists to catch, so the `catch` also reads as framed — never the reverse: a check that fails open (assumes not-framed on any error) is not a check. */
function isFramed(): boolean {
  try {
    return window.top !== window.self
  } catch {
    return true
  }
}

type State =
  | { kind: 'loading' }
  | { kind: 'framed' }
  | { kind: 'signed-out'; clientName?: string }
  | { kind: 'consent'; clientName?: string; redirectHost: string }
  | { kind: 'unavailable' }

export function ConnectAssistant({
  requestId,
  account,
  onSignedIn,
  navigate,
}: ConnectAssistantProps) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [decideError, setDecideError] = useState<ApiError | undefined>(
    undefined
  )
  const [deciding, setDeciding] = useState(false)

  // Re-read on every mount this screen reaches, and again whenever
  // `account`/`requestId` change — the same "the server is what actually
  // knows" discipline `pages/Connect.tsx`'s own status effect follows,
  // rather than this page guessing its own state from a locally-held flag.
  //
  // Rework round 1, must-fix 2 — checked *before* the fetch, not only before
  // the render: a framed load must neither claim the pending authorization
  // (`GET /oauth/mcp/request`'s own signed-in side effect,
  // `routes/mcp-oauth-consent.ts`) nor learn anything about it, so this
  // effect does nothing at all once framed, rather than fetching and merely
  // discarding the answer.
  useEffect(() => {
    if (isFramed()) {
      setState({ kind: 'framed' })
      return
    }
    let cancelled = false
    setState({ kind: 'loading' })
    getConnectAssistantRequest(requestId).then(
      (response) => {
        if (cancelled) return
        if (!response.signedIn) {
          setState({
            kind: 'signed-out',
            ...(response.clientName ? { clientName: response.clientName } : {}),
          })
          return
        }
        setState({
          kind: 'consent',
          ...(response.clientName ? { clientName: response.clientName } : {}),
          redirectHost: response.redirectHost,
        })
      },
      (caught: unknown) => {
        if (cancelled) return
        if (caught instanceof ApiError) {
          setState({ kind: 'unavailable' })
        } else throw caught
      }
    )
    return () => {
      cancelled = true
    }
  }, [requestId, account])

  const handleDecide = async (decision: 'allow' | 'deny') => {
    setDecideError(undefined)
    setDeciding(true)
    try {
      const { redirectTo } = await decideConnectAssistantRequest(
        requestId,
        decision
      )
      // An off-origin URL — the client's own `redirect_uri` — so this is a
      // real navigation, never this app's own `history.replaceState` device.
      window.location.assign(redirectTo)
    } catch (caught) {
      setDeciding(false)
      // Rework round 1, must-fix 4 — a 404 here means the request itself is
      // gone (expired or consumed between load and this click), not a
      // transient failure Allow/Deny could ever retry into succeeding:
      // transition to the same `unavailable` screen a load-time 404 already
      // renders, rather than showing a generic error beside two buttons
      // that can only 404 again.
      if (caught instanceof ApiError && caught.status === 404) {
        setState({ kind: 'unavailable' })
        return
      }
      if (caught instanceof ApiError) setDecideError(caught)
      else throw caught
    }
  }

  // LINK-11 rework, must-fix 3 (this file's own module comment) — keyed on
  // `state.kind === 'consent'`, the server's own signed-in answer, never on
  // the client-held `account` prop alone: `account` can be stale (a session
  // that expired between `App.tsx`'s last `/auth/me` and this page's own
  // fetch) in a way `state` cannot, since `state` is set directly from what
  // `GET /oauth/mcp/request` most recently answered. `account` is still
  // narrowed here (defensively, not assumed — this codebase's own "defended,
  // not assumed" discipline) since nothing about `state.kind` alone proves
  // it to the type checker, even though `'consent'` cannot in practice be
  // reached with a `null` `account`.
  const withChrome = (content: React.ReactNode) => {
    if (!account || state.kind !== 'consent') {
      return (
        <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
          <SignInHeader />
          {content}
        </div>
      )
    }
    const defaultOrganization = resolveDefaultOrganization(account)
    return (
      <SignedInChrome
        account={account}
        activeOrganizationId={defaultOrganization?.organizationId}
        isMember={defaultOrganization?.isMember ?? false}
        navigate={navigate}
        onSignedOut={onSignedIn}
      >
        {content}
      </SignedInChrome>
    )
  }

  if (state.kind === 'framed') {
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
        <SignInHeader />
        <div
          className="flex flex-col gap-3"
          data-testid="connect-assistant-framed"
        >
          <h2 className="text-page-title font-semibold text-neutral-900">
            Open this page directly to connect an assistant
          </h2>
          <p className="text-sm text-neutral-700">
            For your safety, this page will not show a connection request while
            it is embedded inside another page. Open the link directly, in its
            own tab or window.
          </p>
        </div>
      </div>
    )
  }

  if (state.kind === 'loading') {
    return withChrome(
      <div
        className="flex flex-col gap-3"
        data-testid="connect-assistant-loading"
      >
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-24" />
        <LoadingStatus />
      </div>
    )
  }

  if (state.kind === 'unavailable') {
    return withChrome(
      <div
        className="flex flex-col gap-3"
        data-testid="connect-assistant-unavailable"
      >
        <h2 className="text-page-title font-semibold text-neutral-900">
          This connection request is no longer available
        </h2>
        <p className="text-sm text-neutral-700">
          It may have expired, already been used, or belong to a different
          signed-in account. Go back to your assistant and start connecting it
          again.
        </p>
      </div>
    )
  }

  if (state.kind === 'signed-out') {
    // MCP-11/AUTH-6 — `destination` carries this exact page back through
    // the emailed sign-in link, regardless of which browsing context
    // redeems it, the identical mechanism `pages/JoinLink.tsx`/
    // `pages/Connect.tsx` already use for their own returns.
    return withChrome(
      <SignIn
        onSignedIn={onSignedIn}
        destination={`/connect-assistant/${requestId}`}
        headline="Sign in to Bloombot to connect"
        description={`${clientLabel(state.clientName)} wants to connect to your Bloombot account. Sign in below to continue — you will see exactly what is being requested before anything is granted.`}
      />
    )
  }

  // `state.kind === 'consent'` — signed in, the disclosure and decision
  // screen (security review, must-fix 2 — this file's own module comment).
  return withChrome(
    <div
      className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-8"
      data-testid="connect-assistant-consent"
    >
      <h1 className="text-page-title font-semibold text-neutral-900">
        Connect this assistant to your Bloombot account
      </h1>
      <p className="text-sm text-neutral-700">
        <strong>{clientLabel(state.clientName)}</strong> will act as your
        Bloombot account — it will be able to do everything you can do through
        the API, in every organization you already belong to. It gains no course
        access beyond what your account already has.
      </p>
      <p className="text-sm text-neutral-700">
        Approving this sends a connection code to:{' '}
        <strong>{state.redirectHost}</strong>
      </p>
      <div className="flex gap-3">
        <Button
          variant="primary"
          onClick={() => void handleDecide('allow')}
          disabled={deciding}
        >
          {deciding ? 'Connecting…' : 'Allow'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void handleDecide('deny')}
          disabled={deciding}
        >
          Deny
        </Button>
      </div>
      {decideError && <ErrorMessage error={decideError} />}
    </div>
  )
}
