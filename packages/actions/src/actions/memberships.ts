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
 *
 * Rework finding 1: `execute` also requires the target to already hold a
 * membership in *this* organization before it will change their role — see
 * that check's own comment, below, for why.
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
 * ENRL-5: grant a membership role to an account that already belongs to this
 * organization, identified by email — never created here (inviting a
 * brand-new account, or a first-time member, is a distinct feature this
 * action does not build; see the rework note below). Resolves the
 * organization itself (there is no existing membership to resolve against on
 * a first grant, the same "no existing record to resolve on create" shape
 * `projects.create` uses); `execute` then checks, in order:
 *
 * 1. The caller (`accountId`) actually has a membership in this
 *    organization, and it is `'owner'` — anyone else is refused, identically
 *    to a not-found (ACT-3).
 * 2. `email` resolves to a real account, *and that account already holds a
 *    membership in this organization* — an email nobody holds, and an email
 *    that resolves somewhere else entirely, are both refused the same way
 *    (see the rework note below).
 * 3. The resolved account is not the caller themselves — a staff role is
 *    never self-selected (ENRL-5), even by an owner granting themselves a
 *    *different* role.
 *
 * Rework finding 1: check 2 used to be "does `email` resolve to *any*
 * account", through the organization-independent `accounts.getAccountByEmail`
 * — a check with no membership requirement at all. Sign-in is open to
 * anybody, and a first-time signer becomes owner of their own personal
 * organization (TEN-1), so *any* caller could sign in and call this against
 * their own organization with an arbitrary email: a 200 (a membership now
 * exists) meant that address held an account somewhere on this platform, and
 * a refusal meant it did not — exactly the account-existence oracle the
 * unauthenticated sign-in path deliberately withholds. Worse, the resolved
 * account — a real person who runs this platform elsewhere, who never asked
 * to be added — would end up holding a membership in a stranger's
 * organization, visible through their own `GET /auth/me`. Requiring
 * `memberships.getMembership` to already find a row closes both: this
 * action can only ever change the role of somebody already known to belong
 * to this tenant, never invite a stranger's account into it or use this
 * action to learn whether a given email has one anywhere at all. ENRL-5
 * asks for no invitation flow, and this slice does not add one — a first
 * membership for a second instructor or TA (`memberships.createMembership`,
 * `repos/memberships.ts`) is a distinct feature, left to a later slice.
 */
export const grantMembershipAction: Action<
  'memberships.grant',
  GrantInput,
  Organization,
  memberships.Membership
> = {
  name: 'memberships.grant',
  description:
    'Change the membership role of an account that already belongs to this organization (ENRL-5): only an existing owner may call this, never on their own account, and the grant records who made it.',
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

    // Rework finding 1: `email` resolving to *an* account is not enough —
    // it must already be a member of *this* organization, or this check
    // (and `accounts.getAccountByEmail` above, organization-independent by
    // design — `accounts.ts`'s own module comment) becomes a cross-tenant
    // account-existence oracle, and a successful grant would enrol a
    // stranger's account into an organization they never consented to join.
    // Refused identically to an email nobody holds (this function's own doc
    // comment).
    if (!memberships.getMembership(organizationId, target.id, db)) {
      throw new ActionRefusedError()
    }

    // ENRL-5: never self-selected, even by an owner.
    if (target.id === accountId) throw new ActionRefusedError()

    return memberships.grantMembershipRole(
      organizationId,
      { accountId: target.id, role: input.role, grantedByAccountId: accountId },
      db
    )
  },
}
