/**
 * ENRL-8: redeem a course join link. Mounted at `/join-links`, unscoped by
 * `:organizationId` — the same reason `routes/auth.ts` is unscoped
 * (`@bloombot/db`'s `repos/course-join-links.ts`'s own module comment): a
 * redeemer presents only the secret from the link they were given, not an
 * organization id, so there is nothing to scope this route by until the
 * secret itself resolves one.
 *
 * `packages/db/src/repos/course-join-links.ts#redeemJoinLink`'s own doc
 * comment names the trap a careless route would fall into: `POST /join
 * { secret, personId }`, with `personId` taken straight from the request
 * body, would let anyone holding the link's (deliberately shareable)
 * secret enrol *anybody* in the tenant. `postRedeemInputSchema` below is
 * `z.strictObject`, not `z.object` — the same "a plain `z.object` silently
 * strips a key it does not recognize rather than refusing it"
 * `actions/courses.ts`'s own `saveInputSchema` comment gives for the same
 * device — so a caller that adds `personId` (or anything else) to the body
 * is refused outright, `action_input_invalid`-shaped, rather than having
 * that field quietly ignored. The person actually enrolled
 * (`callerAssertedPersonId`, in `@bloombot/db`'s own vocabulary) always
 * comes from `req.session.accountId` — the caller's own already-proven
 * identity — through `@bloombot/actions`'
 * `redeemCourseJoinLinkForWebAccount`.
 *
 * Refusals stay not-found-shaped, and identical, for a secret that was
 * never issued, one that is revoked, and one that has expired (ENRL-4) —
 * this route adds no branch of its own between "signed in" and "here is
 * what redeeming did": every one of those three refusals is the single
 * `undefined` `redeemCourseJoinLinkForWebAccount` already returns, mapped
 * here to the one `join_link_not_found` response, at the one place in this
 * handler that reads it back.
 */

import { Router } from 'express'
import { z } from 'zod'

import { redeemCourseJoinLinkForWebAccount } from '@bloombot/actions'
import type { Database } from '@bloombot/db'

export interface JoinLinksRouterDependencies {
  db: Database
}

const postRedeemInputSchema = z.strictObject({ secret: z.string().min(1) })

export function buildJoinLinksRouter(
  deps: JoinLinksRouterDependencies
): Router {
  const router = Router()

  /** ENRL-8: redeem a course join link, bound to the caller's own signed-in identity. */
  router.post('/redeem', (req, res, next) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    const parsed = postRedeemInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'action_input_invalid', issues: parsed.error.issues })
      return
    }
    try {
      const enrolment = redeemCourseJoinLinkForWebAccount(
        parsed.data.secret,
        req.session.accountId,
        deps.db
      )
      if (!enrolment) {
        // ENRL-4's own "no oracle" shape: never issued, revoked and expired
        // all land here, identically — see this file's own module comment.
        res.status(404).json({ error: 'join_link_not_found' })
        return
      }
      res.status(200).json({ courseId: enrolment.courseId })
    } catch (error) {
      next(error)
    }
  })

  return router
}
