/**
 * API-3, and the half of AUTH-3 ("non-GET requests are checked against
 * their origin") `packages/auth`'s own D-19 explicitly left for this slice:
 * a session cookie is sent by the browser on every request to this API's
 * origin regardless of which page asked for it, so a form on somebody
 * else's site can trigger a state-changing request carrying a student's or
 * instructor's own cookie. This is what stands between that cookie and
 * such a request.
 *
 * Runs before the session is even read (`server.ts` mounts this ahead of
 * `sessionMiddleware`) and, critically, before any route can dispatch an
 * action — a refused request never reaches `routes/actions.ts` or
 * `routes/auth.ts` at all, not merely a dispatch call inside one of them
 * that happens to error out.
 */

import type { NextFunction, Request, Response } from 'express'

/** The scheme+host+port portion of a URL, or `undefined` if `value` does not parse as one. */
function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * Build the origin-check middleware for `expectedAppUrl` (`CONFIG.PUBLIC_APP_URL`
 * in production — see `src/index.ts`).
 *
 * Checked against `Origin` first, falling back to `Referer` only when
 * `Origin` is absent — some browsers omit `Origin` on certain same-site
 * requests but still send `Referer`, and AUTH-3's own text calls out both.
 *
 * A `GET` (or `HEAD`) request is never checked: the requirement's own text
 * is "non-GET", and a `GET` is not supposed to change anything in the first
 * place — ACT-1's actions are the platform's only write path, and every one
 * of them is dispatched from a non-GET route (`routes/actions.ts`).
 *
 * **A non-GET request with neither header present is refused, not allowed
 * through.** A same-site `fetch`/form submission from this API's own
 * front end always carries `Origin` — no legitimate browser request this
 * API expects to serve is missing both, so treating "absent" as "allowed"
 * would not exempt some real, awkward client; it would just be the way this
 * whole check quietly stops doing anything, the failure mode this file's
 * own module comment warns about. See `docs/DECISIONS.md`.
 */
export function originCheck(expectedAppUrl: string) {
  const expectedOrigin = originOf(expectedAppUrl) ?? expectedAppUrl

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      next()
      return
    }

    const originHeader = req.get('origin')
    const refererHeader = req.get('referer')
    const candidate = originHeader ?? originOf(refererHeader ?? '')

    if (candidate !== expectedOrigin) {
      res.status(403).json({ error: 'origin_refused' })
      return
    }

    next()
  }
}
