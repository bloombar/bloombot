/**
 * MCP-7's own human-facing half. `apps/mcp/src/oauth-provider.ts#authorize`
 * writes a pending authorization row (`@bloombot/db`'s `mcp_oauth_pending_authorizations`,
 * the same shared database — one filesystem, PLAT-4 — every process in this
 * platform already reads and writes) and redirects the browser here rather
 * than deciding anything itself: `apps/mcp` has no session of its own to
 * check against (this app's own cookie, `middleware/session.ts`, is what
 * proves who is signed in), so the actual "does a person consent" step has
 * to happen wherever that cookie is already readable.
 *
 * **Reuses the existing session; does not build a second login.** A
 * signed-in request (`req.session.accountId` already set — this app's own
 * global `sessionMiddleware`) goes straight to a plain consent screen. A
 * signed-out request is told, plainly, to sign in with the control panel in
 * another tab and come back — this file deliberately does not attempt to
 * carry a "return here after signing in" destination through the panel's
 * own sign-in flow: the panel's `SignIn.tsx` has no such mechanism for its
 * Google path today ("that sign-in never leaves this tab, so it has
 * nothing to carry a destination for" — that component's own doc comment),
 * and the email-link path's `destination` is parsed as an in-app *route*
 * by `App.tsx`'s own `returnToShell`, never navigated to as a literal
 * server path — neither carries a caller to an address outside the SPA's
 * own routing. Reloading *this* URL after signing in elsewhere works
 * correctly with no such mechanism at all, because the session cookie this
 * route reads is the same cookie the panel's own sign-in already set — this
 * route only has to be visited again, not carried anywhere by the sign-in
 * flow itself. `docs/DECISIONS.md`'s MCP-7 entry records this as a known,
 * deliberate rough edge: a proper "continue where you left off" experience
 * belongs in the panel itself, in a slice that owns `apps/web`, not this
 * one — this route's own two-tab fallback is what makes the flow *work*
 * today without touching a single file there.
 *
 * Plain server-rendered HTML, not a React page — this route lives entirely
 * in `apps/api`, deliberately outside `apps/web`, and answers with an inert
 * HTML string on every path below. No client-side script, no build step,
 * nothing for a future panel screen to conflict with if one replaces this
 * later.
 */

import { Router } from 'express'
import { z } from 'zod'

import {
  consentToPendingAuthorization,
  declinePendingAuthorization,
  peekPendingAuthorization,
} from '@bloombot/auth'
import type { Database } from '@bloombot/db'

export interface McpOauthConsentRouterDependencies {
  db: Database
  /** `CONFIG.PUBLIC_APP_URL` — where "sign in" links back to. */
  publicAppUrl: string
}

/** Escapes the handful of characters that would otherwise let a client's own registered name or redirect URI break out of the HTML this route writes — this route has no templating engine of its own (this file's own module comment: plain strings, deliberately), so this is the one thing standing between "a client registered a name with `<script>` in it" and reflected XSS on a page a signed-in account is looking at. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function htmlPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; line-height: 1.5;">
${bodyHtml}
</body>
</html>`
}

const decideInputSchema = z.object({
  request: z.string().min(1),
  decision: z.enum(['allow', 'deny']),
})

export function buildMcpOauthConsentRouter(
  deps: McpOauthConsentRouterDependencies
): Router {
  const router = Router()

  /**
   * MCP-7's own consent screen. Read-only — `peekPendingAuthorization`
   * spends nothing (LINK-6's own "a visit is not consent," applied here:
   * this is a redirect the browser followed on its own, not a person's
   * decision) — so reloading this URL any number of times, before or after
   * signing in elsewhere in the same browser, is always safe.
   */
  router.get('/authorize', (req, res) => {
    const requestId =
      typeof req.query['request'] === 'string' ? req.query['request'] : ''
    if (!requestId) {
      res
        .status(400)
        .send(htmlPage('Bloombot', '<p>Missing or invalid request.</p>'))
      return
    }

    const pending = peekPendingAuthorization(requestId, deps.db)
    if (!pending) {
      res
        .status(404)
        .send(
          htmlPage(
            'Bloombot',
            '<p>This connection request has expired or was already used. Go back to your assistant and try connecting it again.</p>'
          )
        )
      return
    }

    if (!req.session) {
      const signInUrl = `${deps.publicAppUrl}/`
      res.status(200).send(
        htmlPage(
          'Sign in to connect',
          `<h1>Sign in to connect this assistant</h1>
<p>You are not signed in. Open Bloombot in another tab, sign in, then come back to this tab and reload the page.</p>
<p><a href="${escapeHtml(signInUrl)}" target="_blank" rel="noopener">Open Bloombot sign-in</a></p>
<p><a href="${escapeHtml(req.originalUrl)}">I've signed in — continue</a></p>`
        )
      )
      return
    }

    const clientLabel = pending.clientName
      ? escapeHtml(pending.clientName)
      : 'An MCP assistant'
    res.status(200).send(
      htmlPage(
        'Connect this assistant',
        `<h1>Connect this assistant to your Bloombot account</h1>
<p><strong>${clientLabel}</strong> will act as your Bloombot account — it will be able to do everything you can do through the API, in every organization you already belong to. It gains no course access beyond what your account already has.</p>
<form method="POST" action="/oauth/mcp/authorize/decide">
  <input type="hidden" name="request" value="${escapeHtml(requestId)}">
  <button type="submit" name="decision" value="allow">Allow</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>`
      )
    )
  })

  /**
   * MCP-7's own non-negotiable, enforced here structurally: `accountId`
   * comes from `req.session` — this route's own already-authenticated
   * cookie — never from the submitted form, so nothing in this request's
   * body can name a different account than whoever is actually signed in
   * on this browser. A signed-out submission (the cookie expired between
   * loading the form and submitting it) is refused the same way the `GET`
   * above is.
   */
  router.post('/authorize/decide', (req, res) => {
    const parsed = decideInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).send(htmlPage('Bloombot', '<p>Invalid request.</p>'))
      return
    }
    if (!req.session) {
      res
        .status(401)
        .send(htmlPage('Bloombot', '<p>You are not signed in.</p>'))
      return
    }

    if (parsed.data.decision === 'deny') {
      const pending = peekPendingAuthorization(parsed.data.request, deps.db)
      declinePendingAuthorization(parsed.data.request, deps.db)
      if (!pending) {
        res
          .status(404)
          .send(
            htmlPage('Bloombot', '<p>This request has already expired.</p>')
          )
        return
      }
      const denied = new URL(pending.redirectUri)
      denied.searchParams.set('error', 'access_denied')
      res.redirect(302, denied.toString())
      return
    }

    const issued = consentToPendingAuthorization(
      parsed.data.request,
      req.session.accountId,
      deps.db
    )
    if (!issued) {
      res
        .status(404)
        .send(
          htmlPage(
            'Bloombot',
            '<p>This connection request has expired or was already used. Go back to your assistant and try connecting it again.</p>'
          )
        )
      return
    }

    const redirect = new URL(issued.redirectUri)
    redirect.searchParams.set('code', issued.code)
    if (issued.state !== undefined) {
      redirect.searchParams.set('state', issued.state)
    }
    res.redirect(302, redirect.toString())
  })

  return router
}
