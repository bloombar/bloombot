/**
 * API-4 / ACT-4 — the one place a thrown error becomes an HTTP status. No
 * route in `routes/actions.ts` or `routes/auth.ts` catches a dispatch error
 * and maps it itself; every one of them calls `next(error)` and lets this
 * run, so a refusal for a missing record and a refusal for another
 * organization's record — `ActionRefusedError` either way, ACT-3 — come
 * back as the exact same status and body, and an unexpected failure never
 * leaks its detail into a response body a caller can read.
 *
 * `HTTP_STATUS_BY_ACTION_ERROR` (`@bloombot/actions`) is the table this
 * reads; this file adds nothing to it and invents no mapping of its own.
 */

import type { NextFunction, Request, Response } from 'express'

import {
  ActionConflictError,
  ActionInputError,
  HTTP_STATUS_BY_ACTION_ERROR,
} from '@bloombot/actions'
import type { Logger } from '@bloombot/logger'

/** A thrown value with the shape every typed action error carries — `code`, matched against `HTTP_STATUS_BY_ACTION_ERROR`. */
function actionErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  return undefined
}

/**
 * Must-fix 4 of the API-1..6 rework: `express.json()` (`server.ts`) rejects
 * malformed JSON and an over-limit body through `body-parser`, whose errors
 * (via `http-errors`) carry a numeric `status`/`statusCode` and `expose:
 * true` for exactly these client-caused 4xx cases — but no `code`, so
 * `actionErrorCode` above never matches them and they fell through to the
 * "unexpected" branch: a `500` the caller should never see for its own bad
 * request, and an error-level log line on every occurrence. Because body
 * parsing runs *before* `originCheck` (`server.ts`'s own ordering comment),
 * that log line was reachable from an unauthenticated, cross-origin page —
 * driving unbounded error-level log growth was the actual finding, not just
 * the wrong status code. `expose` is checked, not merely presence of a
 * status: `http-errors` sets `expose: false` on a 5xx it builds for an
 * *unexpected* failure inside body-parser, and that case must still reach
 * the log below, not be silently reported as an ordinary 4xx.
 */
function exposedClientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    expose?: unknown
  }
  if (candidate.expose !== true) return undefined
  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined
  if (status === undefined || status < 400 || status >= 500) return undefined
  return status
}

/**
 * Build the error-handling middleware. Express recognises this as an error
 * handler by its four-parameter signature — dropping any one parameter
 * (even an unused `req`) turns it into an ordinary middleware Express will
 * never call for a thrown error.
 */
export function errorMiddleware(logger: Logger) {
  return (
    error: unknown,
    req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by Express's four-arity error-handler signature.
    next: NextFunction
  ): void => {
    const code = actionErrorCode(error)
    const status = code ? HTTP_STATUS_BY_ACTION_ERROR[code] : undefined

    if (code && status) {
      const body: Record<string, unknown> = { error: code }
      // ActionInputError/ActionConflictError are the two typed errors ACT-4
      // itself allows to say more than "refused" — a validation failure
      // names the fields that failed, a conflict names what it collided
      // with (see docs/DECISIONS.md D-18). ActionRefusedError and
      // UnknownActionError carry nothing beyond `code` on purpose.
      if (error instanceof ActionInputError) body['issues'] = error.issues
      if (error instanceof ActionConflictError)
        body['conflict'] = error.conflict
      res.status(status).json(body)
      return
    }

    const clientErrorStatus = exposedClientErrorStatus(error)
    if (clientErrorStatus !== undefined) {
      res.status(clientErrorStatus).json({ error: 'invalid_request' })
      return
    }

    // Anything else is unexpected: the caller gets no detail (API-4), the
    // log gets everything — request method/path for correlation, and the
    // error itself for the stack trace this response deliberately withholds.
    logger.error(
      { err: error, method: req.method, path: req.path },
      'apps/api: unexpected error handling a request'
    )
    res.status(500).json({ error: 'internal_error' })
  }
}
