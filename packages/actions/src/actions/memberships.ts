/**
 * Actions over `packages/db`'s `memberships` repo (ENRL-5, ENRL-11):
 * `memberships.grant`, `memberships.list` and `memberships.revoke`.
 *
 * Membership roles carry authority over a tenant's courses, transcripts and
 * spending, and ENRL-5 requires they are "granted only by an existing owner
 * through an action that is recorded" and never self-selected. `grantMembershipAction`
 * is the one action in the platform that grants one — no other action, and no
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
 *
 * An audit (`docs/ROADMAP.md`'s "Audit — surfaces that were never built")
 * found `grantMembershipAction` had no caller outside this package's own
 * tests — no route, no panel screen — so an owner had no actual way to add a
 * second instructor or a teaching assistant, and `listMembershipsForOrganization`
 * (`@bloombot/db`'s own `repos/memberships.ts`) had no caller at all, so
 * there was no way to see who already held a role. `listMembershipsAction`,
 * below, is the read half that closes the second gap; `apps/web`'s own
 * `components/Team.tsx` and `api/client.ts` are what close the first, this
 * same slice.
 *
 * **`revokeMembershipAction` (ENRL-11) closes the gap D-67 and D-68 both
 * named and left open: nothing revoked a membership, and nothing stopped an
 * organization losing its last owner.** Once ENRL-10 made an outside
 * account reachable as an owner at all, that owner could call
 * `grantMembershipAction` to demote the founding owner with no way back —
 * this action is the recourse: an owner may revoke a colleague's standing,
 * recorded the same way a grant already is (`repos/memberships.ts#revokeMembership`'s
 * own doc comment).
 *
 * **Decision this requirement exists to settle: an owner's own membership
 * may only ever be revoked by that owner, stepping down themselves — never
 * by a peer.** `grantMembershipAction` already lets one owner demote
 * *another* to a lesser role (unchanged by this slice, out of scope per
 * this requirement's own brief), so the identical peer-to-peer reach
 * already exists there; closing it here as well, for the strictly more
 * final act of removing a colleague's standing outright, is this
 * requirement's own answer to the question its SPEC text names as
 * unsettled. See `docs/DECISIONS.md` D-70 for the reasoning and what this
 * does not close (the pre-existing `grantMembershipAction` path).
 *
 * **The last-owner invariant is enforced in the repo, not here.**
 * `revokeMembership`'s own doc comment has why: this action's `execute`
 * cannot be the last line of defense against an organization losing its
 * only owner, because it is not the only caller `revokeMembership` will
 * ever have. What `execute` cannot tell apart from `revokeMembership`'s own
 * `undefined` return — the last owner, versus nothing left to revoke at
 * all — it does not need to: both are `ActionRefusedError`, the same
 * "refused, not-found-shaped" TEN-5 already gives every other refusal in
 * this package.
 */

import { accounts, memberships, organizations, schema } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Organization = NonNullable<
  ReturnType<typeof organizations.getOrganizationById>
>

// `z.strictObject`, not `z.object`: a plain `z.object` silently drops a key
// it does not declare, which would make `grantedByAccountId` or `grantedAt`
// typed into this body indistinguishable from one that was never sent at
// all — `execute` never reads either off `input` regardless (both are
// stamped from the session's own `accountId`, below), but a caller sending
// them deserves an explicit `action_input_invalid` refusal, not silent
// disregard, the same "fail loud on an unknown field" discipline this
// action's own `grantedByAccountId` guarantee depends on being visibly true,
// not merely true by omission.
const grantInputSchema = z.strictObject({
  email: z.email(),
  role: z.enum(schema.MEMBERSHIP_ROLES),
})
type GrantInput = z.infer<typeof grantInputSchema>

/**
 * ENRL-5: grant a membership role to an account that already belongs to this
 * organization, identified by email — never created here. Inviting an
 * address with no membership yet is `membership-invitations.ts`'s own job
 * (ENRL-10) — a distinct act, deliberately: changing an existing member's
 * role and admitting a first-time one carry different consequences (that
 * file's own doc comment on `redeemMembershipInvitation`'s "already a
 * member" refusal), so this action stays exactly what the rework note below
 * closed it down to, rather than widened to cover both. Resolves the
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
 * action to learn whether a given email has one anywhere at all. A first
 * membership for a second instructor or TA now has a path —
 * `membershipInvitations.create`/`redeemMembershipInvitationForWebAccount`
 * (ENRL-10, `membership-invitations.ts`) — that closes the same oracle a
 * different way: by never looking `email` up against `accounts` at all, so
 * inviting an address with no account is indistinguishable from inviting
 * one that has one. This action's own restriction to an *existing* member
 * stays exactly as this rework left it.
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

// `z.strictObject`, the same reason `grantInputSchema`'s own comment gives:
// a caller sending `revokedByAccountId` (always stamped from the session's
// own `accountId`, below, never read off `input`) deserves an explicit
// `action_input_invalid` refusal, not silent disregard.
const revokeInputSchema = z.strictObject({
  accountId: z.string().min(1),
})
type RevokeInput = z.infer<typeof revokeInputSchema>

type TargetMembership = NonNullable<
  ReturnType<typeof memberships.getMembership>
>

/**
 * ENRL-11: revoke a membership — removes staff authority and nothing else
 * (`repos/memberships.ts#revokeMembership`'s own doc comment); it deletes no
 * transcript and ends no enrolment, the same rule TEN-6 and ENRL-6 already
 * hold to for the identical reason.
 *
 * `resolve` reaches the target through `memberships.getMembership`, scoped
 * to the caller's own organization (TEN-5) — a target belonging to another
 * organization, or one already revoked, refuses identically to one that
 * never existed, before `execute` ever runs. *Who* may call this — only an
 * existing owner — and the peer-owner restriction below are `execute`'s own
 * checks, not the policy's, for the identical reason `grantMembershipAction`'s
 * own module comment gives: a policy cannot see the caller's account id.
 */
export const revokeMembershipAction: Action<
  'memberships.revoke',
  RevokeInput,
  TargetMembership,
  { revoked: boolean }
> = {
  name: 'memberships.revoke',
  description:
    "Revoke a membership (ENRL-11): removes the holder's staff authority and nothing else — no transcript deleted, no enrolment ended. Only an existing owner may call this; an owner's own membership may only be revoked by that owner stepping down, never by a peer; and the organization's last owner can never be revoked.",
  inputSchema: revokeInputSchema,
  policy: {
    descriptor: { resource: 'membership', access: 'write' },
    resolve: (input, context) =>
      memberships.getMembership(
        context.organizationId,
        input.accountId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, accountId, db }) => {
    if (!accountId) throw new ActionRefusedError()

    const callerMembership = memberships.getMembership(
      organizationId,
      accountId,
      db
    )
    if (!callerMembership || callerMembership.role !== 'owner') {
      throw new ActionRefusedError()
    }

    // ENRL-11's own decision, this file's own module comment has the
    // reasoning: an owner's own membership is revoked only by that owner,
    // stepping down themselves — never by a peer, even another owner. A
    // non-owner target (instructor, assistant) carries no such
    // restriction; any owner may revoke one.
    if (entity.role === 'owner' && entity.accountId !== accountId) {
      throw new ActionRefusedError()
    }

    const revoked = memberships.revokeMembership(
      organizationId,
      { accountId: entity.accountId, revokedByAccountId: accountId },
      db
    )
    if (!revoked) {
      // Reached only when `entity` was this organization's sole remaining
      // owner, revoking themselves — the repo's own last-owner invariant
      // (`revokeMembership`'s own doc comment), not this action's.
      throw new ActionRefusedError()
    }
    return { revoked: true }
  },
}

const listInputSchema = z.strictObject({}).default({})
type ListInput = z.infer<typeof listInputSchema>

/**
 * ENRL-5's read side: one entry per membership `listMembershipsForOrganization`
 * (`@bloombot/db`'s `repos/memberships.ts`) already returns — that repo
 * function's own row already carries the role, `grantedByAccountId` and
 * `grantedAt` this needs, so nothing there needed to change. What this adds
 * is a display name for the two account ids that row carries: `accountId`
 * (the holder) and, when present, `grantedByAccountId` (the granter) —
 * `accounts.getAccountById` for each, the same TEN-2-exception lookup
 * `routes/auth.ts`'s own `/auth/me` already uses to turn an account id into
 * something a person reads. Never email: `displayName` is what identifies a
 * *holder* here, the same "no genuine need to disambiguate by it" reasoning
 * `pages/Usage.tsx`/`components/CoursePeople.tsx` already give for a
 * student's own row — an account's `displayName` is `NOT NULL`
 * (`schema.ts`), so unlike those two, there is no `null` case to fall back
 * from at all.
 */
export interface MembershipEntry {
  accountId: string
  displayName: string
  role: memberships.MembershipRole
  grantedByAccountId: string | null
  /** `null` for the one membership nobody grants — the founding owner row `accounts.createAccount` writes inline (`schema.ts`'s own comment on `grantedByAccountId`) — and for any other row a caller wrote directly rather than through `grantMembershipRole`. */
  grantedByDisplayName: string | null
  grantedAt: number | null
  createdAt: number
}

/**
 * ENRL-5 — list every membership role held in the caller's own organization,
 * who holds it, who granted it, and when. Read, not write, so — unlike
 * `grantMembershipAction` above — this is open to any member, not only an
 * owner: seeing who is already staff carries none of a grant's own
 * account-level consequences, the same "a read needs no extra role check"
 * shape `costLedger.organizationUsage` already takes over `costLedger.setSpendingCap`'s
 * own owner-only write.
 */
export const listMembershipsAction: Action<
  'memberships.list',
  ListInput,
  Organization,
  MembershipEntry[]
> = {
  name: 'memberships.list',
  description:
    "List every membership role held in the caller's organization (ENRL-5): who holds it, who granted it, and when.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'read' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, db }) => {
    const rows = memberships.listMembershipsForOrganization(organizationId, db)
    return rows.map((row) => {
      // A membership's own `accountId` references `accounts.id` (`schema.ts`)
      // — `account` should always resolve — but this reads it back rather
      // than trusting the foreign key blindly, the same "do not trust a
      // reference blindly" discipline `grantMembershipRole`'s own `updated`
      // check (`repos/memberships.ts`) already holds itself to; falling back
      // to the id itself keeps a row rendering rather than disappearing if
      // it somehow does not.
      const account = accounts.getAccountById(row.accountId, db)
      const granter = row.grantedByAccountId
        ? accounts.getAccountById(row.grantedByAccountId, db)
        : undefined
      return {
        accountId: row.accountId,
        displayName: account?.displayName ?? row.accountId,
        role: row.role,
        grantedByAccountId: row.grantedByAccountId,
        grantedByDisplayName:
          granter?.displayName ?? row.grantedByAccountId ?? null,
        grantedAt: row.grantedAt,
        createdAt: row.createdAt,
      }
    })
  },
}
