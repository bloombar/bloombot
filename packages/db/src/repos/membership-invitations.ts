/**
 * Repository for `membership_invitations` (ENRL-10).
 *
 * `createInvitation`/`getInvitation`/`listInvitations`/`revokeInvitation` are
 * scoped by `organizationId`, its first parameter, the same as every other
 * function in this package. `redeemMembershipInvitation` is the one
 * documented exception, the same class `course-join-links.ts`'s own module
 * comment describes for its own redemption functions: a redeemer presents
 * only the secret, not an organization id, so there is nothing to scope the
 * lookup by until the hash itself resolves one.
 *
 * Every function here operates on the invitation's *hash*. The plaintext
 * secret is generated and returned to the caller exactly once, by
 * `@bloombot/actions`' `membership-invitations.ts` — this file never sees it
 * and never writes it.
 */

import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'

import type { Database, TransactingExecutor } from '../client.js'
import { getAccountById } from './accounts.js'
import * as memberships from './memberships.js'
import { membershipInvitations, type MembershipRole } from '../schema.js'

export type MembershipInvitation = typeof membershipInvitations.$inferSelect

/** Fields the caller supplies when issuing an invitation. */
export interface NewMembershipInvitation {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  email: string
  role: MembershipRole
  /** SHA-256 hash of the secret; see `@bloombot/actions`' `membership-invitations.ts`. */
  secretHash: string
  /** `null`/omitted: no expiry, valid until revoked or redeemed. */
  expiresAt?: number | null
  createdByAccountId: string
}

/**
 * Issue (insert) a new invitation row. `email` is stored lowercased, the
 * same convention `accounts.email` and `sign_in_tokens.email` already use —
 * redemption (below) compares an account's own, already-lowercased email
 * against this column directly.
 */
export function createInvitation(
  organizationId: string,
  input: NewMembershipInvitation,
  db: Database
): MembershipInvitation {
  return db
    .insert(membershipInvitations)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      email: input.email.toLowerCase(),
      role: input.role,
      secretHash: input.secretHash,
      expiresAt: input.expiresAt ?? null,
      createdByAccountId: input.createdByAccountId,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/** One invitation by id, scoped to `organizationId` — for `@bloombot/actions`' `membershipInvitations.revoke` policy to resolve before revoking it. */
export function getInvitation(
  organizationId: string,
  invitationId: string,
  db: Database
): MembershipInvitation | undefined {
  return db
    .select()
    .from(membershipInvitations)
    .where(
      and(
        eq(membershipInvitations.id, invitationId),
        eq(membershipInvitations.organizationId, organizationId)
      )
    )
    .get()
}

/**
 * Every invitation an organization has ever issued, newest first — the same
 * "history, not only what is currently live" shape
 * `course-join-links.ts#listJoinLinks` already gives WEB-20's own screen, so
 * an owner can see a revoked or already-redeemed invitation alongside a
 * still-outstanding one, not merely lose track of it. Returns the row as
 * stored, `secretHash` included — the same "a plain read is not the
 * boundary that decides what a browser may see" reasoning
 * `listJoinLinks`'s own doc comment gives; `@bloombot/actions`'
 * `membershipInvitations.list` is where that projection happens.
 */
export function listInvitations(
  organizationId: string,
  db: Database
): MembershipInvitation[] {
  return db
    .select()
    .from(membershipInvitations)
    .where(eq(membershipInvitations.organizationId, organizationId))
    .orderBy(desc(membershipInvitations.createdAt))
    .all()
}

/**
 * Revoke an invitation — stops it admitting anyone, ever again. Returns the
 * number of rows changed: `0` for an invitation that does not exist,
 * belongs to a different organization (TEN-5), is already revoked, or has
 * already been redeemed (single-use — there is nothing left for a revoke to
 * stop). The same "rows-changed, not state" shape
 * `course-join-links.ts#revokeJoinLink` already gives ENRL-4's identical
 * verb.
 */
export function revokeInvitation(
  organizationId: string,
  invitationId: string,
  db: Database
): number {
  const result = db
    .update(membershipInvitations)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(membershipInvitations.id, invitationId),
        eq(membershipInvitations.organizationId, organizationId),
        isNull(membershipInvitations.revokedAt),
        isNull(membershipInvitations.redeemedAt)
      )
    )
    .run()
  return result.changes
}

/**
 * The one query `redeemMembershipInvitation` runs first: an invitation that
 * is live by its hash (not revoked, not already redeemed, not expired) —
 * never issued, revoked, expired and already-redeemed all fall through this
 * same single `WHERE`, so a caller cannot time or otherwise distinguish the
 * four (ENRL-10's own "no oracle" shape, the same one
 * `course-join-links.ts#findLiveJoinLinkByHash` already gives ENRL-3/4).
 * Module-private: nothing outside this file has a reason to see an
 * invitation before deciding who it is being redeemed for.
 */
function findLiveInvitationByHash(
  secretHash: string,
  now: number,
  tx: TransactingExecutor
): MembershipInvitation | undefined {
  return tx
    .select()
    .from(membershipInvitations)
    .where(
      and(
        eq(membershipInvitations.secretHash, secretHash),
        isNull(membershipInvitations.revokedAt),
        isNull(membershipInvitations.redeemedAt),
        or(
          isNull(membershipInvitations.expiresAt),
          gt(membershipInvitations.expiresAt, now)
        )
      )
    )
    .get()
}

/**
 * ENRL-10: redeem an invitation by its hash, for a signed-in web account —
 * grants `accountId` the role it names in the invitation's own organization,
 * or refuses (`undefined`). `accountId` comes from the caller's own
 * already-authenticated session, never a request body — the same obligation
 * `course-join-links.ts#redeemJoinLinkForWebAccount`'s own doc comment
 * states, and for the identical reason: an invitation is a bearer secret,
 * and a route that took an account id from the request body would let
 * anyone holding it grant a role to somebody else.
 *
 * Refuses identically (`undefined`) on four conditions, all indistinguishable
 * from the caller's point of view:
 *
 *  1. The hash was never issued, is revoked, has expired, or was already
 *     redeemed — `findLiveInvitationByHash`'s own single `WHERE` (above).
 *  2. The caller's own account email does not match the address this
 *     invitation was addressed to. This is what makes ENRL-10's "admits
 *     exactly the person who received it" actually true rather than merely
 *     "admits whoever holds the secret first" — a join link is deliberately
 *     shared with a whole class, so nothing about presenting *that* secret
 *     proves who is presenting it (`course-join-links.ts#redeemJoinLink`'s
 *     own doc comment), but an invitation is addressed to one person, and
 *     without this check a leaked secret (a forwarded email, a screenshot)
 *     would let any signed-in stranger become staff of an organization they
 *     were never invited to. `account.email` is compared directly, not
 *     re-lowercased: both this column and `accounts.email` are already
 *     stored lowercased by their own repo layers (this file's own
 *     `createInvitation`, `repos/accounts.ts`'s own module comment), the
 *     same "already a verified, normalized fact" reasoning
 *     `redeemJoinLinkForWebAccount`'s own rework gives `account.email` for
 *     PPL-5.
 *  3. `accountId` already holds *any* membership in the invitation's own
 *     organization. Granting a role to someone not yet present and changing
 *     an existing member's role are different acts (`@bloombot/actions`'
 *     `memberships.ts`'s own module comment: `memberships.grant` is
 *     deliberately the only path that changes an *existing* membership) —
 *     an invitation is the former, so this refuses rather than silently
 *     reassigning a role for an account that is already a member. Whoever
 *     actually means to change an existing member's role uses
 *     `memberships.grant`, the same owner-only, recorded path ENRL-5
 *     already gives that act.
 *
 * Atomic, the same "narrow the race, don't just document it" discipline
 * `redeemJoinLink`'s own rework finding 6 holds itself to: the liveness
 * read, the two checks above, and the claim below all run inside one
 * `db.transaction(...)`. Unlike that function, the guard against a
 * concurrent revoke is not left to the underlying engine's own
 * write-transaction isolation — it is a second, explicit re-check
 * (`claimInvitation`, below): the same conditions `findLiveInvitationByHash`
 * already checked, re-applied in the `WHERE` of the one `UPDATE` that
 * actually claims the row, the "a write whose own WHERE re-checks the
 * condition its read relied on" pattern `repos/memberships.ts#grantMembershipRole`'s
 * own `updated` check already uses for the identical reason. A concurrent
 * revoke that commits between this function's own read and its claim
 * affects that `UPDATE`'s row count directly — `0` rather than `1` — so
 * this refuses deterministically rather than racing the database engine's
 * own conflict detection.
 *
 * The claim happens *after* checks 2 and 3, deliberately, not as
 * `findLiveInvitationByHash`'s own first statement: claiming (setting
 * `redeemedAt`) is what makes an invitation single-use, and doing it before
 * either check would burn a legitimate invitation on a failed attempt — the
 * actual recipient signing in with the wrong account, say, or an account
 * that already joined some other way — leaving nothing for them to redeem
 * with the very next, correct attempt.
 */
export function redeemMembershipInvitation(
  secretHash: string,
  accountId: string,
  now: number,
  db: Database
): memberships.Membership | undefined {
  return db.transaction((tx) => {
    const invitation = findLiveInvitationByHash(secretHash, now, tx)
    if (!invitation) return undefined

    const account = getAccountById(accountId, tx)
    if (!account) return undefined
    if (account.email !== invitation.email) return undefined

    if (memberships.getMembership(invitation.organizationId, accountId, tx)) {
      return undefined
    }

    const claimed = claimInvitation(invitation.id, accountId, now, tx)
    if (!claimed) return undefined

    return memberships.grantMembershipRole(
      invitation.organizationId,
      {
        accountId,
        role: invitation.role,
        grantedByAccountId: invitation.createdByAccountId,
      },
      tx
    )
  })
}

/**
 * The single conditional `UPDATE` that actually claims an invitation — this
 * function's own doc comment on `redeemMembershipInvitation` has the full
 * reasoning for why this re-checks liveness rather than trusting the read
 * that already ran. Returns the claimed row, or `undefined` if a concurrent
 * writer (a revoke, or another in-flight redemption of the same secret) won
 * the race first.
 */
function claimInvitation(
  invitationId: string,
  accountId: string,
  now: number,
  tx: TransactingExecutor
): MembershipInvitation | undefined {
  return tx
    .update(membershipInvitations)
    .set({ redeemedAt: now, redeemedByAccountId: accountId })
    .where(
      and(
        eq(membershipInvitations.id, invitationId),
        isNull(membershipInvitations.revokedAt),
        isNull(membershipInvitations.redeemedAt),
        or(
          isNull(membershipInvitations.expiresAt),
          gt(membershipInvitations.expiresAt, now)
        )
      )
    )
    .returning()
    .get()
}
