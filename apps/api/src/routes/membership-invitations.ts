/**
 * ENRL-10: redeem a membership invitation. Mounted at `/membership-invitations`,
 * unscoped by `:organizationId` — the same reason `routes/join-links.ts` is
 * unscoped (that file's own module comment, and `@bloombot/db`'s
 * `repos/membership-invitations.ts`'s own): a redeemer presents only the
 * secret from the invitation they were given, not an organization id, so
 * there is nothing to scope this route by until the secret itself resolves
 * one.
 *
 * `postRedeemInputSchema` below is `z.strictObject`, not `z.object` — the
 * same "a plain `z.object` silently strips a key it does not recognize
 * rather than refusing it" device `routes/join-links.ts`'s own schema
 * already uses, for the identical reason: a caller that adds an `accountId`
 * (or anything else) to the body is refused outright,
 * `action_input_invalid`-shaped, rather than having that field quietly
 * ignored. The account actually granted a role always comes from
 * `req.session.accountId` — the caller's own already-proven identity —
 * through `@bloombot/actions`' `redeemMembershipInvitationForWebAccount`.
 *
 * Refusals stay not-found-shaped, and identical, for a secret that was
 * never issued, one that is revoked, one that has expired, one that was
 * already redeemed (ENRL-10's own single-use property), one whose account
 * email does not match the invited address, and one for an account that
 * already holds a membership in that organization
 * (`repos/membership-invitations.ts#redeemMembershipInvitation`'s own doc
 * comment names all four/six) — this route adds no branch of its own
 * between "signed in" and "here is what redeeming did": every one of those
 * is the single `undefined` that function already returns, mapped here to
 * the one `membership_invitation_not_found` response, at the one place in
 * this handler that reads it back.
 */

import { Router } from 'express'
import { z } from 'zod'

import { redeemMembershipInvitationForWebAccount } from '@bloombot/actions'
import type { Database } from '@bloombot/db'

export interface MembershipInvitationsRouterDependencies {
  db: Database
}

const postRedeemInputSchema = z.strictObject({ secret: z.string().min(1) })

export function buildMembershipInvitationsRouter(
  deps: MembershipInvitationsRouterDependencies
): Router {
  const router = Router()

  /** ENRL-10: redeem a membership invitation, bound to the caller's own signed-in identity. */
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
      const membership = redeemMembershipInvitationForWebAccount(
        parsed.data.secret,
        req.session.accountId,
        deps.db
      )
      if (!membership) {
        // ENRL-10's own "no oracle" shape: never issued, revoked, expired,
        // already redeemed, a wrong-account attempt and an already-a-member
        // account all land here, identically — see this file's own module
        // comment.
        res.status(404).json({ error: 'membership_invitation_not_found' })
        return
      }
      res.status(200).json({
        organizationId: membership.organizationId,
        role: membership.role,
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}
