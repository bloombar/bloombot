/**
 * Actions over `packages/db`'s `memberships` repo (ENRL-5): `memberships.grant`.
 *
 * Membership roles carry authority over a tenant's courses, transcripts and
 * spending, and ENRL-5 requires they are "granted only by an existing owner
 * through an action that is recorded" and never self-selected. This is the
 * one action in the platform that grants one — no other action, and no
 * surface, offers a staff role as a choice — and it enforces both rules
 * itself, in `execute`, because `PolicyContext` (`policy.ts`) carries only
 * `organizationId` and `db`, never the caller's own account id: "is the
 * caller an owner" and "is the caller granting themselves a role" are both
 * questions about *who is calling*, which only `execute`'s own `accountId`
 * (`dispatch.ts`'s own `DispatchContext.accountId`) can answer.
 */

import { accounts, memberships, organizations, schema } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Organization = NonNullable<
  ReturnType<typeof organizations.getOrganizationById>
>

const grantInputSchema = z.object({
  email: z.email(),
  role: z.enum(schema.MEMBERSHIP_ROLES),
})
type GrantInput = z.infer<typeof grantInputSchema>

/**
 * ENRL-5: grant a membership role to an existing account, identified by
 * email — never created here (inviting a brand-new account is a distinct
 * feature this action does not build). Resolves the organization itself
 * (there is no existing membership to resolve against on a first grant, the
 * same "no existing record to resolve on create" shape `projects.create`
 * uses); `execute` then checks, in order:
 *
 * 1. The caller (`accountId`) actually has a membership in this
 *    organization, and it is `'owner'` — anyone else is refused, identically
 *    to a not-found (ACT-3).
 * 2. `email` resolves to a real account — an email nobody holds is refused
 *    the same way.
 * 3. The resolved account is not the caller themselves — a staff role is
 *    never self-selected (ENRL-5), even by an owner granting themselves a
 *    *different* role.
 */
export const grantMembershipAction: Action<
  'memberships.grant',
  GrantInput,
  Organization,
  memberships.Membership
> = {
  name: 'memberships.grant',
  description:
    'Grant a membership role to an existing account (ENRL-5): only an existing owner may call this, never on their own account, and the grant records who made it.',
  inputSchema: grantInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'write' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, accountId, db }) => {
    if (!accountId) throw new ActionRefusedError()

    const callerMembership = memberships.getMembership(
      organizationId,
      accountId,
      db
    )
    if (!callerMembership || callerMembership.role !== 'owner') {
      throw new ActionRefusedError()
    }

    const target = accounts.getAccountByEmail(input.email, db)
    if (!target) throw new ActionRefusedError()

    // ENRL-5: never self-selected, even by an owner.
    if (target.id === accountId) throw new ActionRefusedError()

    return memberships.grantMembershipRole(
      organizationId,
      { accountId: target.id, role: input.role, grantedByAccountId: accountId },
      db
    )
  },
}
