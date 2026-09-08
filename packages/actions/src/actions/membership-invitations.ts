/**
 * Actions over `packages/db`'s `membership-invitations` repo (ENRL-10):
 * `membershipInvitations.create`, `.list` and `.revoke`, dispatched the
 * ordinary way — and `redeemMembershipInvitation`, which is *not* a
 * dispatched `Action` at all, the same class `course-join-links.ts`'s own
 * module comment describes for its own redemption functions: a redeemer
 * presents only the secret, not an organization id, which
 * `dispatch.ts`'s own `DispatchContext.organizationId` has to be known
 * before a single line of an action runs.
 *
 * This is the surface `memberships.ts`'s own module comment (and D-67,
 * `docs/DECISIONS.md`) names as missing: `memberships.grant` only ever
 * changes the role of an account that already holds a membership in this
 * organization, and nothing before this file ever created that first one.
 * An invitation is that missing first-membership admission path, closed the
 * same way `memberships.grant` itself is closed — refusing an address it
 * cannot resolve to an account would make invitation *creation* an
 * account-existence oracle the same way an unguarded `memberships.grant`
 * was (that action's own rework finding 1); `createMembershipInvitationAction`
 * below never looks an email up at all, so inviting an address with no
 * account behaves identically, from the caller's own point of view, to
 * inviting one that has one (ENRL-10's own text).
 *
 * `generateSecret`/`hashSecret` below are the same small, deliberate
 * duplicate `course-join-links.ts` already carries of `@bloombot/auth`'s
 * `secrets.ts` — not imported from that file either: both are module-private
 * there, and a secret this small is cheaper to repeat than to thread a new
 * shared export through for.
 */

import {
  memberships,
  membershipInvitations,
  organizations,
  schema,
  type Database,
} from '@bloombot/db'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Organization = NonNullable<
  ReturnType<typeof organizations.getOrganizationById>
>
type Invitation = NonNullable<
  ReturnType<typeof membershipInvitations.getInvitation>
>

const SECRET_BYTES = 32

/** A new high-entropy, URL-safe secret. Never stored; only `hashSecret(secret)` is. */
function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

/** The SHA-256 hash of a secret, hex-encoded, for storage and lookup. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * `memberships.grant`'s own check, unchanged: only an existing owner may act
 * here, and never on their own account — the same shape `execute` cannot
 * express as a `Policy` (`PolicyContext` carries no caller account id,
 * `policy.ts`'s own module comment), so every action in this file re-runs
 * it itself, module-private the same way `course-join-links.ts`'s own
 * `requireAccountId` is (`docs/DECISIONS.md` on why small helpers like this
 * stay un-shared).
 */
function requireOwner(
  organizationId: string,
  accountId: string | undefined,
  db: Database
): string {
  if (!accountId) throw new ActionRefusedError()
  const caller = memberships.getMembership(organizationId, accountId, db)
  if (!caller || caller.role !== 'owner') throw new ActionRefusedError()
  return accountId
}

const createInputSchema = z.strictObject({
  email: z.email(),
  role: z.enum(schema.MEMBERSHIP_ROLES),
  /**
   * Epoch milliseconds. Omitted or `null`: no expiry, valid until revoked or
   * redeemed. Mirrors `courseJoinLinks.create`'s own `expiresAt` exactly,
   * including its own "must be strictly in the future" refinement — the
   * identical reasoning applies: a past value would create an invitation
   * that reports success but can never be redeemed.
   */
  expiresAt: z
    .number()
    .int()
    .positive()
    .refine((value) => value > Date.now(), {
      message: 'expiresAt must be in the future',
    })
    .nullable()
    .optional(),
})
type CreateInput = z.infer<typeof createInputSchema>

/** What `membershipInvitations.create` hands back — the plaintext secret, exactly once, never recoverable afterward. */
export interface CreatedMembershipInvitation {
  invitationId: string
  /** Put this in the link an invitee redeems; never written to the database. */
  secret: string
  expiresAt: number | null
}

/**
 * ENRL-10: invite `email` to `role` in the caller's own organization. Only
 * an existing owner may call this (`requireOwner`, above) — the same
 * restriction `memberships.grant` already holds itself to, for the same
 * reason (ENRL-5: a staff role is never self-selected, and is granted only
 * by an existing owner). Never looks `email` up against `accounts` at all —
 * see this file's own module comment on why that omission, not a check, is
 * what keeps this from becoming the oracle `memberships.grant`'s own rework
 * closed.
 */
export const createMembershipInvitationAction: Action<
  'membershipInvitations.create',
  CreateInput,
  Organization,
  CreatedMembershipInvitation
> = {
  name: 'membershipInvitations.create',
  description:
    'Invite an email address to a role in this organization (ENRL-10): returns the secret to share with the invitee exactly once — the database only ever stores its hash. Only an existing owner may call this.',
  inputSchema: createInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'write' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, accountId, db }) => {
    const createdByAccountId = requireOwner(organizationId, accountId, db)
    const secret = generateSecret()

    const invitation = membershipInvitations.createInvitation(
      organizationId,
      {
        email: input.email,
        role: input.role,
        secretHash: hashSecret(secret),
        expiresAt: input.expiresAt ?? null,
        createdByAccountId,
      },
      db
    )

    return {
      invitationId: invitation.id,
      secret,
      expiresAt: invitation.expiresAt,
    }
  },
}

const listInputSchema = z.strictObject({}).default({})
type ListInput = z.infer<typeof listInputSchema>

/**
 * What `membershipInvitations.list` hands back for each invitation —
 * deliberately narrower than `repos/membership-invitations.ts`'s own
 * `MembershipInvitation` row, the same "never mirror a sensitive column
 * just because the row happens to carry it" discipline
 * `course-join-links.ts#CourseJoinLinkSummary`'s own doc comment already
 * applies to `secretHash`: a response that included it would hand a
 * caller everything needed to redeem every invitation the organization has
 * ever issued, not only the one just created. Unlike a join link's own
 * summary, `email` stays *in* this projection — it is the one thing that
 * identifies an invitee who is not yet visible in `memberships.list`'s own
 * roster, the same reason `Team.tsx`'s own grant form asks an owner to type
 * one (`docs/DECISIONS.md` D-67).
 */
export interface MembershipInvitationSummary {
  id: string
  email: string
  role: memberships.MembershipRole
  expiresAt: number | null
  revokedAt: number | null
  redeemedAt: number | null
  createdByAccountId: string
  createdAt: number
}

function toSummary(
  invitation: membershipInvitations.MembershipInvitation
): MembershipInvitationSummary {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    revokedAt: invitation.revokedAt,
    redeemedAt: invitation.redeemedAt,
    createdByAccountId: invitation.createdByAccountId,
    createdAt: invitation.createdAt,
  }
}

/**
 * ENRL-10: list every invitation the caller's own organization has ever
 * issued, newest first — outstanding, revoked and already-redeemed alike
 * (`repos/membership-invitations.ts#listInvitations`'s own doc comment on
 * why this is a history, not only a queue). Owner-only, unlike
 * `memberships.list` (`actions/memberships.ts`'s own doc comment: any
 * member may see who already holds a role). An outstanding invitation
 * carries an email nobody has consented to have shown around the
 * organization yet — the same sensitivity `Team.tsx`'s own grant form
 * already treats an owner-typed email with — so this stays behind the same
 * `requireOwner` gate `.create`/`.revoke` use, rather than the open read
 * `memberships.list` gives a granted role. See `docs/DECISIONS.md` for this
 * slice's own record of the choice.
 */
export const listMembershipInvitationsAction: Action<
  'membershipInvitations.list',
  ListInput,
  Organization,
  MembershipInvitationSummary[]
> = {
  name: 'membershipInvitations.list',
  description:
    "List every invitation the caller's organization has ever issued (ENRL-10): email, role, expiry, revoked and redeemed state for each — never the secret, which only ever existed at creation. Only an existing owner may call this.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'read' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, accountId, db }) => {
    requireOwner(organizationId, accountId, db)
    return membershipInvitations
      .listInvitations(organizationId, db)
      .map(toSummary)
  },
}

const revokeInputSchema = z.strictObject({
  invitationId: z.string().min(1),
})
type RevokeInput = z.infer<typeof revokeInputSchema>

/**
 * ENRL-10: revoke an invitation — stops it admitting anyone, ever
 * (`repos/membership-invitations.ts#revokeInvitation`'s own doc comment).
 * Owner-only, the same gate `.create`/`.list` above use: an assistant or an
 * instructor must not be able to unilaterally close an owner's own pending
 * invitation.
 */
export const revokeMembershipInvitationAction: Action<
  'membershipInvitations.revoke',
  RevokeInput,
  Invitation,
  { revoked: boolean }
> = {
  name: 'membershipInvitations.revoke',
  description:
    'Revoke an invitation (ENRL-10): stops it admitting anyone, ever again. Only an existing owner may call this.',
  inputSchema: revokeInputSchema,
  policy: {
    descriptor: { resource: 'membershipInvitation', access: 'write' },
    resolve: (input, context) =>
      membershipInvitations.getInvitation(
        context.organizationId,
        input.invitationId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, accountId, db }) => {
    requireOwner(organizationId, accountId, db)
    // Idempotent no-op on an invitation already revoked or already redeemed
    // — the policy already proved this invitation exists and belongs to
    // this organization, so there is no refusal case left here (the same
    // "rows-changed is not state" treatment `courseJoinLinks.revoke`
    // already gives this shape).
    membershipInvitations.revokeInvitation(organizationId, entity.id, db)
    return { revoked: true }
  },
}

/**
 * ENRL-10: redeem an invitation for a signed-in web account — the composed
 * entry point `apps/api`'s own invitations route calls, the same way
 * `course-join-links.ts#redeemCourseJoinLinkForWebAccount` composes
 * `hashSecret` with its own repo function for an already-authenticated
 * caller. Named with the same `ForWebAccount` suffix, deliberately, even
 * though this package has only the one redemption flavor today (unlike
 * `course-join-links.ts`'s bare `redeemJoinLink`/`.ForWebAccount` pair) — a
 * bare `redeemMembershipInvitation` here would collide, at the call site,
 * with `@bloombot/db`'s own `membershipInvitations.redeemMembershipInvitation`
 * this composes, which is confusing even where it does not error.
 * `accountId` comes from the caller's own already-authenticated session —
 * never a request body — the same obligation that file's own doc comment
 * states, and for the identical reason: there is no account id parameter
 * here for a caller to mis-supply in the first place.
 *
 * Not a dispatched `Action`: see this file's own module comment.
 */
export function redeemMembershipInvitationForWebAccount(
  secret: string,
  accountId: string,
  db: Database
) {
  return membershipInvitations.redeemMembershipInvitation(
    hashSecret(secret),
    accountId,
    Date.now(),
    db
  )
}
