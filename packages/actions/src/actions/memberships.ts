/**
 * Actions over `packages/db`'s `memberships` repo (ENRL-5): `memberships.grant`
 * and `memberships.list`.
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
