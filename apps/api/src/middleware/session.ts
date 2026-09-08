/**
 * API-2 — reads the session cookie, validates it, and attaches whatever it
 * proves to the request. Anonymous is not an error: a request with no
 * cookie, or one that no longer validates, simply gets no `req.session` —
 * it is up to each route (`routes/actions.ts`, `routes/auth.ts`) to decide
 * whether that is acceptable for what it is about to do.
 *
 * `validateSession` (`@bloombot/auth`) writes on every call — it touches
 * `last_seen_at` (D-19's "Finding 9") — so this middleware runs it exactly
 * once per request, never more, and every downstream route reads
 * `req.session` rather than re-validating the cookie itself.
 *
 * This is the one place in the API that reads the `Cookie` header and the
 * one place that writes the `Set-Cookie` response for the session — no
 * cookie-parsing library is pulled in for a single named cookie.
 */

import type { NextFunction, Request, Response } from 'express'

import { validateSession, type ValidSession } from '@bloombot/auth'
import type { Database } from '@bloombot/db'

/**
 * The one cookie this API sets. Not `HttpOnly` alone — see `setSessionCookie`
 * below for the full attribute set API-2 requires.
 */
export const SESSION_COOKIE_NAME = 'bloombot_session'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- this is how Express itself documents augmenting `Request`.
  namespace Express {
    interface Request {
      /** Set by `sessionMiddleware` when the session cookie names a currently-valid session. `undefined` for an anonymous request — not an error. */
      session?: ValidSession
      /** The raw cookie value, when present, valid or not — `routes/auth.ts`'s sign-out needs the plaintext token to revoke the session server-side; `req.session` alone cannot recover it. */
      sessionToken?: string
    }
  }
}

/** Parse a `Cookie` request header into name/value pairs. Deliberately minimal: this API sets and reads exactly one cookie. */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=')
    if (separatorIndex === -1) continue
    const name = part.slice(0, separatorIndex).trim()
    const value = part.slice(separatorIndex + 1).trim()
    if (!name) continue
    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      // A malformed percent-encoding in a cookie value is the client's own
      // mistake, not a reason to fail the request — treat it as absent.
    }
  }
  return cookies
}

/** Reads the session cookie (if any) and validates it against `db`, attaching the result to `req`. */
export function sessionMiddleware(db: Database) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const cookies = parseCookieHeader(req.headers.cookie)
    const token = cookies[SESSION_COOKIE_NAME]
    if (token) {
      req.sessionToken = token
      const valid = validateSession(token, db)
      if (valid) req.session = valid
    }
    next()
  }
}

/**
 * Set the session cookie (API-2): `HttpOnly` so no script can read it,
 * `Secure` so it is never sent in the clear, `SameSite=Lax` (see
 * `docs/DECISIONS.md` for why not `Strict` — a stricter setting would drop
 * the cookie on the very top-level navigation AUTH-1's emailed sign-in link
 * produces), scoped to the whole site (`Path=/`), and expiring exactly when
 * the session itself does rather than living on as a stale cookie past that
 * point.
 */
export function setSessionCookie(
  res: Response,
  session: { token: string; expiresAt: number }
): void {
  res.cookie(SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.expiresAt),
  })
}

/** Clears the session cookie. Signing out also revokes the session server-side (`routes/auth.ts`) — clearing the cookie alone would leave the token itself still valid if it were ever replayed. */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  })
}
