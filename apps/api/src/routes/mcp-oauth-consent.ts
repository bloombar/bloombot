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
 *  - the consent screen below names the client (or says plainly that it
 *    has no registered name — never a reassuring generic placeholder) and
 *    the redirect URI's own host, so a person has something to refuse;
 *  - every pending authorization is bound to the first signed-in account
 *    that touches it (`claimPendingAuthorization`, `@bloombot/auth`) and
 *    refuses a different one — `schema.ts#mcpOauthPendingAuthorizations`'s
 *    own doc comment has the full reasoning for what this does and does
 *    not defend against on its own;
 *  - `X-Frame-Options`/CSP `frame-ancestors` (below) close the framing
 *    angle: without them, this screen — even corrected — could be framed
 *    and an `Allow` click harvested without the victim ever seeing it;
 *  - a signed-out visitor is sent through a real sign-in round trip
 *    (`/sign-in`, `/redeem`, below) rather than told to open another tab
 *    and reload — the reviewer's own finding that this was the *same*
 *    mechanism making the `request` id transferable between people, not a
 *    separate defect from the one above.
 *
 * **Reuses the existing sign-in; does not build a second login.** The
 * round trip below calls `@bloombot/auth`'s own `requestSignInLink`/
 * `redeemSignInLink` — the identical functions `routes/auth.ts#/request-link`/
 * `#/redeem` already call for the panel's own emailed-link sign-in — from a
 * plain server-rendered form instead of the React panel. This is forced by
 * this slice's own concurrency constraints (a different slice was mid-edit
 * on `apps/web/src/pages/Shell.tsx` and its routing when this shipped), not
 * chosen for its own sake: the panel's own `SignIn.tsx` (Google or email)
 * would be the better long-term surface for this, once nothing else is
 * mid-edit there — `docs/DECISIONS.md`'s MCP-7 entry records this
 * explicitly as follow-up, not as a design this route recommends keeping.
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
  claimPendingAuthorization,
  consentToPendingAuthorization,
  declinePendingAuthorization,
  peekPendingAuthorization,
  redeemSignInLink,
  requestSignInLink,
  type EmailSender,
} from '@bloombot/auth'
import type { Database } from '@bloombot/db'

import { setSessionCookie } from '../middleware/session.js'

export interface McpOauthConsentRouterDependencies {
  db: Database
  /** `CONFIG.PUBLIC_APP_URL` — the origin every link this route builds is relative to. */
  publicAppUrl: string
  /** The mail port the sign-in round trip below sends through — a real transport in production, `RecordingEmailSender` in a test (this file's own module comment on why this round trip exists at all). */
  emailSender: EmailSender
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

/** The generic 404 every failure on this surface answers with, regardless of *why* a pending authorization did not resolve — an unknown id, an expired one, and one already bound to a different account all read identically (this file's own module comment on `claimPendingAuthorization`'s "no oracle" refusal, the same discipline every other single-use secret in this platform already holds itself to). */
function expiredOrUnknown(): string {
  return htmlPage(
    'Bloombot',
    '<p>This connection request has expired, was already used, or belongs to a different signed-in account. Go back to your assistant and try connecting it again.</p>'
  )
}

/** How a client that registered with no `client_name` is described — never a reassuring placeholder like "An MCP assistant" (the security review's own finding: that string read as legitimate regardless of who was actually asking). */
function clientLabel(clientName: string | undefined): string {
  return clientName
    ? escapeHtml(clientName)
    : 'An application with no registered name'
}

const decideInputSchema = z.object({
  request: z.string().min(1),
  decision: z.enum(['allow', 'deny']),
})

const signInInputSchema = z.object({
  email: z.email(),
  request: z.string().min(1),
})

/** `/oauth/mcp/authorize?request=<id>` — the one path every sign-in link and every redirect on this surface returns to. */
function authorizePath(requestId: string): string {
  return `/oauth/mcp/authorize?request=${encodeURIComponent(requestId)}`
}

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
   * MCP-7's own consent screen. Read-only for a signed-out visitor
   * (`peekPendingAuthorization` spends nothing, LINK-6's own "a visit is
   * not consent") — a signed-in visitor additionally calls
   * `claimPendingAuthorization`, which *does* write (binding this row to
   * this account, once), but still decides nothing about the client
   * itself; only the `POST` below does that.
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

    const preview = peekPendingAuthorization(requestId, deps.db)
    if (!preview) {
      res.status(404).send(expiredOrUnknown())
      return
    }

    if (!req.session) {
      res.status(200).send(
        htmlPage(
          'Sign in to connect',
          `<h1>Sign in to connect this assistant</h1>
<p><strong>${clientLabel(preview.clientName)}</strong> wants to connect to your Bloombot account. Sign in below to continue — you will see exactly what is being requested before anything is granted.</p>
<form method="POST" action="/oauth/mcp/sign-in">
  <input type="hidden" name="request" value="${escapeHtml(requestId)}">
  <label for="email">Email address</label><br>
  <input type="email" id="email" name="email" required autofocus><br><br>
  <button type="submit">Send me a sign-in link</button>
</form>`
        )
      )
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
      res.status(404).send(expiredOrUnknown())
      return
    }

    const destinationHost = new URL(claimed.redirectUri).host
    res.status(200).send(
      htmlPage(
        'Connect this assistant',
        `<h1>Connect this assistant to your Bloombot account</h1>
<p><strong>${clientLabel(claimed.clientName)}</strong> will act as your Bloombot account — it will be able to do everything you can do through the API, in every organization you already belong to. It gains no course access beyond what your account already has.</p>
<p>Approving this sends a connection code to: <strong>${escapeHtml(destinationHost)}</strong></p>
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
   * on this browser. `consentToPendingAuthorization`/`declinePendingAuthorization`
   * (`@bloombot/auth`) both re-assert the same claim
   * `claimPendingAuthorization` checked at `GET` — a session that expired
   * or changed account between loading the form and submitting it is
   * refused here too, not merely at render time.
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
      const declined = declinePendingAuthorization(
        parsed.data.request,
        req.session.accountId,
        deps.db
      )
      if (!declined) {
        res.status(404).send(expiredOrUnknown())
        return
      }
      const denied = new URL(declined.redirectUri)
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
      res.status(404).send(expiredOrUnknown())
      return
    }

    const redirect = new URL(issued.redirectUri)
    redirect.searchParams.set('code', issued.code)
    if (issued.state !== undefined) {
      redirect.searchParams.set('state', issued.state)
    }
    res.redirect(302, redirect.toString())
  })

  /**
   * The sign-in round trip's own first half — issues a sign-in link the
   * same way `routes/auth.ts#/request-link` does (`requestSignInLink`,
   * `@bloombot/auth`), carrying this pending authorization's own path as
   * the link's `destination` (AUTH-6: validated same-origin path, the
   * identical mechanism the panel's own emailed sign-in already uses) so
   * redeeming it lands back on the exact consent screen this visitor
   * started from. Always the same response regardless of whether the
   * address has an account — AUTH-1's own guarantee, unchanged here.
   */
  router.post('/sign-in', (req, res, next) => {
    const parsed = signInInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).send(htmlPage('Bloombot', '<p>Invalid request.</p>'))
      return
    }
    requestSignInLink(
      parsed.data.email,
      {
        db: deps.db,
        emailSender: deps.emailSender,
        buildLink: (token) =>
          `${deps.publicAppUrl}/oauth/mcp/redeem?token=${token}`,
      },
      authorizePath(parsed.data.request)
    )
      .then(() => {
        res.status(200).send(
          htmlPage(
            'Check your email',
            `<h1>Check your email</h1>
<p>If an account exists for that address, a sign-in link is on its way. Open it on this device to continue connecting your assistant.</p>`
          )
        )
      })
      .catch(next)
  })

  /**
   * The sign-in round trip's own second half — redeems the token the
   * emailed link carried (`redeemSignInLink`, the identical function
   * `routes/auth.ts#/redeem` calls), sets the session cookie directly
   * (there is no client-side script here to do it, unlike the panel's own
   * `RedeemLink.tsx`), and redirects the browser to the token's own
   * `destination` — landing back on `GET /authorize`, now signed in, which
   * is what actually claims the pending authorization
   * (`claimPendingAuthorization`, above).
   */
  router.get('/redeem', (req, res) => {
    const token =
      typeof req.query['token'] === 'string' ? req.query['token'] : ''
    if (!token) {
      res
        .status(400)
        .send(htmlPage('Bloombot', '<p>Missing or invalid token.</p>'))
      return
    }
    const result = redeemSignInLink(token, deps.db)
    if (!result) {
      res
        .status(401)
        .send(
          htmlPage(
            'Bloombot',
            '<p>This sign-in link is invalid or has expired. Go back to your assistant and try connecting it again.</p>'
          )
        )
      return
    }
    setSessionCookie(res, result.session)
    res.redirect(302, result.destination ?? `${deps.publicAppUrl}/`)
  })

  return router
}
