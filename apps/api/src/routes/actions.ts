/**
 * ACT-1's single write path, reachable over HTTP: one route dispatches any
 * registered action by its dotted name, rather than one hand-written route
 * per action (see `docs/DECISIONS.md` for why) — `packages/actions`'s own
 * catalog (ACT-6) already indexes every action by exactly this name, so a
 * route that dispatches by name needs no route-per-action list to keep in
 * sync with it, and a new action registered in `packages/actions` reaches
 * this API with no change here at all.
 *
 * API-1: this route validates nothing about the action's own input (that is
 * `dispatch`'s job, via the action's zod schema), authorizes nothing itself
 * (that is the action's declared policy), and decides nothing about who may
 * do what. What it does decide, because nothing downstream of it can: which
 * organization the caller is acting within — resolved from the caller's own
 * membership (`memberships.getMembership`), never from the request body, so
 * an action input naming a different `organizationId` (most schemas have no
 * such field at all; `dispatch`'s zod validation would strip it if they
 * did) can never substitute for it.
 */

import { Router } from 'express'

import {
  dispatch,
  UnknownActionError,
  ActionRefusedError,
  type ActionRegistry,
} from '@bloombot/actions'
import { memberships, type Database } from '@bloombot/db'

/** `:organizationId/actions/:actionName` — mounted with `mergeParams` so both route params are visible here regardless of where `server.ts` mounts this router. */
export function buildActionsRouter(
  registry: ActionRegistry,
  db: Database
): Router {
  const router = Router({ mergeParams: true })

  // The route parameter type is spelled out explicitly: `mergeParams` makes
  // `:organizationId` (from wherever `server.ts` mounts this router) visible
  // on `req.params` at runtime, but this router's own route pattern
  // (`/:actionName`) is all Express's types would otherwise see it — so
  // without this, `req.params['organizationId']` below type-checks as `any`
  // rather than the string it actually is.
  router.post<{ organizationId: string; actionName: string }>(
    '/:actionName',
    (req, res, next) => {
      // No session, no dispatch (API-1) — an anonymous caller cannot reach an
      // authenticated action, whatever its own policy would otherwise allow.
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }

      const organizationId = req.params['organizationId']
      const actionName = req.params['actionName']
      if (!organizationId || !actionName) {
        // Unreachable given this router's own route pattern — guarded rather
        // than assumed, the same discipline `apps/bot`'s own routing takes.
        res.status(404).json({ error: 'action_unknown' })
        return
      }

      // The caller's organization, established by their own membership — the
      // same "record does not exist or you have no access to it" refusal
      // ACT-3 gives every other refusal (TEN-5: indistinguishable from
      // absence), not a different error for "you are not a member here."
      const membership = memberships.getMembership(
        organizationId,
        req.session.accountId,
        db
      )
      if (!membership) {
        next(new ActionRefusedError())
        return
      }

      const action = registry.get(actionName)
      if (!action) {
        next(new UnknownActionError(actionName))
        return
      }

      dispatch(action, req.body, { organizationId, db })
        .then((result) => res.status(200).json({ result }))
        .catch(next)
    }
  )

  return router
}
