/**
 * MCP-7's own human-facing half. `apps/mcp/src/oauth-provider.ts#authorize`
 * writes a pending authorization row (`@bloombot/db`'s
 * `mcp_oauth_pending_authorizations`, the same shared database — one
 * filesystem, PLAT-4 — every process in this platform already reads and
 * writes) and redirects the browser to `${PUBLIC_APP_URL}/connect-assistant`
 * rather than deciding anything itself: `apps/mcp` has no session of its own
 * to check against (this app's own cookie, `middleware/session.ts`, is what
 * proves who is signed in), so the actual "does a person consent" step has
 * to happen wherever that cookie is already readable.
 *
 * **Security review, must-fix 2 — this screen enabled an account takeover,
 * and the fix is disclosure plus binding, not either alone.** The first
 * version of this route showed "An MCP assistant will act as your Bloombot
 * account" with an `Allow`/`Deny` form and nothing else — no client name,
 * no destination. An attacker registers a client at the open `/register`
 * with their own `redirect_uri`, drives `/authorize` themselves (never in
 * a browser — a script reading the `Location` header is enough), and mails
 * the resulting `request` id to a signed-in victim. The victim saw nothing
 * to refuse and had nothing to read: one click, and a full grant (a
 * 1-hour access token, a 30-day rotating refresh token) went to the
 * attacker's own `redirect_uri`, acting as the victim across every
 * organization they belong to. `state` and PKCE's own `code_challenge`
 * protect the *client* in this flow; neither says anything to the *user*.
 * The fix, all four parts load-bearing together:
 *  - `apps/web/src/pages/ConnectAssistant.tsx` (MCP-11) names the client (or
 *    says plainly that it has no registered name — never a reassuring
 *    generic placeholder) and the redirect URI's own host, so a person has
 *    something to refuse;
 *  - every pending authorization is bound to the first signed-in account
 *    that touches it (`claimPendingAuthorization`, `@bloombot/auth`) and
 *    refuses a different one — `schema.ts#mcpOauthPendingAuthorizations`'s
 *    own doc comment has the full reasoning for what this does and does
 *    not defend against on its own;
 *  - `X-Frame-Options`/CSP `frame-ancestors` (below) close the framing
 *    angle: without them, this screen — even corrected — could be framed
 *    and an `Allow` click harvested without the victim ever seeing it;
 *  - a signed-out visitor is sent through a real sign-in round trip (the
 *    panel's own `SignIn`, via `ConnectAssistant.tsx`) rather than told to
 *    open another tab and reload — the reviewer's own finding that this was
 *    the *same* mechanism making the `request` id transferable between
 *    people, not a separate defect from the one above.
 *
 * **MCP-11 — this is now a JSON API, not a page.** This route used to
 * render its own plain, server-rendered HTML — no logo, no Google, no
 * agreement gate, and its own private copy of the sign-in round trip
 * (`POST /sign-in`, `GET`/`POST /redeem`) — because a different slice was
 * mid-edit on `apps/web`'s own routing when MCP-7 shipped, and the panel's
 * own `SignIn.tsx` was not a safe thing to build against yet
 * (`docs/DECISIONS.md`'s MCP-7 entry recorded this explicitly as follow-up,
 * not as a design worth keeping). That constraint is gone: connecting an
 * assistant now lands on a real page of the panel
 * (`apps/web/src/pages/ConnectAssistant.tsx`), which embeds the panel's own
 * `SignIn` — Google and emailed link, one agreement checkbox gating both —
 * and calls the two endpoints below over `fetch`. Session establishment
 * moves back onto the panel's existing `POST /auth/redeem`, which
 * `originCheck` already covers, so the `GET`-cannot-establish-a-session
 * property the security review's second round fixed here is preserved for
 * free — there is no `GET`/`redeem` pair left in this file to reintroduce
 * it. Every disclosure the old HTML made is still made — the panel just
 * renders it as React now, where an interpolated client name is safe by
 * construction rather than something this file has to escape by hand.
 */

import { Router } from 'express'
import { z } from 'zod'

import {
  claimPendingAuthorization,
  consentToPendingAuthorization,
  declinePendingAuthorization,
  peekPendingAuthorization,
} from '@bloombot/auth'
import type { Database } from '@bloombot/db'

export interface McpOauthConsentRouterDependencies {
  db: Database
}

/** The generic 404 every failure on this surface answers with, regardless of *why* a pending authorization did not resolve — an unknown id, an expired one, and one already bound to a different account all read identically (`claimPendingAuthorization`'s own "no oracle" refusal, the same discipline every other single-use secret in this platform already holds itself to). `apps/web/src/pages/ConnectAssistant.tsx` renders one message for this, and does not try to guess which of the three actually happened. */
function connectionRequestUnavailable(): { error: string } {
  return { error: 'connection_request_unavailable' }
}

const decideInputSchema = z.object({
  request: z.string().min(1),
  decision: z.enum(['allow', 'deny']),
})

export function buildMcpOauthConsentRouter(
  deps: McpOauthConsentRouterDependencies
): Router {
  const router = Router()

  // Security review, must-fix 2 — this screen can grant an account's full
  // authority with one click; a page that could be framed is a page whose
  // click can be harvested without anyone reading it. Set on every
  // response this router ever sends, GET or POST, success or refusal.
  router.use((_req, res, next) => {
    res.set('X-Frame-Options', 'DENY')
    res.set('Content-Security-Policy', "frame-ancestors 'none'")
    next()
  })

  /**
   * MCP-7's own consent data, as JSON. Read-only for a signed-out visitor
   * (`peekPendingAuthorization` spends nothing, LINK-6's own "a visit is
   * not consent") — a signed-in visitor additionally calls
   * `claimPendingAuthorization`, which *does* write (binding this row to
   * this account, once), but still decides nothing about the client
   * itself; only `POST /decide` below does that.
   */
  router.get('/request', (req, res) => {
    const requestId =
      typeof req.query['request'] === 'string' ? req.query['request'] : ''
    if (!requestId) {
      res.status(404).json(connectionRequestUnavailable())
      return
    }

    if (!req.session) {
      const preview = peekPendingAuthorization(requestId, deps.db)
      if (!preview) {
        res.status(404).json(connectionRequestUnavailable())
        return
      }
      res.status(200).json({
        signedIn: false,
        ...(preview.clientName ? { clientName: preview.clientName } : {}),
      })
      return
    }

    // Security review, must-fix 2 — binds this pending authorization to
    // the first signed-in account to reach it, and refuses (identically to
    // an unknown id) a different one; see `claimPendingAuthorization`'s own
    // doc comment (`@bloombot/auth`) for exactly what this does and does
    // not defend against on its own.
    const claimed = claimPendingAuthorization(
      requestId,
      req.session.accountId,
      deps.db
    )
    if (!claimed) {
      res.status(404).json(connectionRequestUnavailable())
      return
    }

    res.status(200).json({
      signedIn: true,
      ...(claimed.clientName ? { clientName: claimed.clientName } : {}),
      redirectHost: new URL(claimed.redirectUri).host,
    })
  })

  /**
   * MCP-7's own non-negotiable, enforced here structurally: `accountId`
   * comes from `req.session` — this route's own already-authenticated
   * cookie — never from the request body, so nothing in it can name a
   * different account than whoever is actually signed in on this browser.
   * `consentToPendingAuthorization`/`declinePendingAuthorization`
   * (`@bloombot/auth`) both re-assert the same claim `GET /request` checked
   * — a session that expired or changed account between loading the
   * consent screen and deciding is refused here too, not merely at render
   * time. Answers the URL the browser must go to rather than a redirect
   * itself (MCP-11): the caller is `fetch` from the panel, not a browser
   * following a `Location` header.
   */
  router.post('/decide', (req, res) => {
    const parsed = decideInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }

    if (parsed.data.decision === 'deny') {
      const declined = declinePendingAuthorization(
        parsed.data.request,
        req.session.accountId,
        deps.db
      )
      if (!declined) {
        res.status(404).json(connectionRequestUnavailable())
        return
      }
      const denied = new URL(declined.redirectUri)
      denied.searchParams.set('error', 'access_denied')
      res.status(200).json({ redirectTo: denied.toString() })
      return
    }

    const issued = consentToPendingAuthorization(
      parsed.data.request,
      req.session.accountId,
      deps.db
    )
    if (!issued) {
      res.status(404).json(connectionRequestUnavailable())
      return
    }

    const redirect = new URL(issued.redirectUri)
    redirect.searchParams.set('code', issued.code)
    if (issued.state !== undefined) {
      redirect.searchParams.set('state', issued.state)
    }
    res.status(200).json({ redirectTo: redirect.toString() })
  })

  return router
}
