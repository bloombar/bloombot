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

/**
 * FILE-1 — a rework finding: `courseAttachments.attach`'s payload carries
 * the file as base64 in the JSON body (`actions/course-attachments.ts`'s
 * own module comment has why a reference is not the shape either), but
 * this router used to rely entirely on `server.ts`'s global
 * `express.json()`, which defaults to 100 kB — base64's 4/3 inflation
 * makes that a ~74 kB *raw file* ceiling, well under a real syllabus or
 * schedule (FILE-1's own text names all three), so a 300 kB PDF was
 * rejected `413` before this action ever ran.
 *
 * `MAX_COURSE_ATTACHMENT_BYTES` is this route's explicit, tested ceiling on
 * a raw file's own size — 20 MiB, generous for a course's notes, syllabus
 * and schedule (a scanned PDF included) without inviting an instructor to
 * treat this as general file storage. `ACTION_JSON_BODY_LIMIT_BYTES` is the
 * JSON body limit that ceiling actually requires: base64 encoding a 20 MiB
 * file takes `ceil(n / 3) * 4` bytes (~26.7 MiB), rounded up to 28 MiB for
 * headroom covering the payload's other fields (`courseId`, `filename`,
 * `contentType`) and JSON's own string escaping — every other action's
 * input is tiny by comparison, so raising this only for the one route that
 * needs it, rather than globally, keeps the rest of this API's own request
 * bodies bounded at `server.ts`'s ordinary default. `server.ts` applies
 * this router's own `express.json({ limit: ACTION_JSON_BODY_LIMIT_BYTES })`
 * *before* its global one — body-parser skips re-parsing a body it already
 * parsed, so mounting the raised limit first is what makes it win for this
 * one path prefix without touching any other route's own limit. Recorded
 * in `docs/DECISIONS.md` D-32.
 */
export const MAX_COURSE_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const ACTION_JSON_BODY_LIMIT_BYTES = 28 * 1024 * 1024

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

      // FILE-4 — the caller's own account, threaded through so an action
      // that records an author (`courseInstructions.save`/`.restore`) has
      // one; `req.session` is already proven non-null above (the same
      // "no session, no dispatch" guard this router's own module comment
      // describes).
      dispatch(action, req.body, {
        organizationId,
        db,
        accountId: req.session.accountId,
      })
        .then((result) => res.status(200).json({ result }))
        .catch(next)
    }
  )

  return router
}
