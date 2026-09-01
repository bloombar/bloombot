/**
 * Repository for `memberships` (TEN-1, TEN-2).
 *
 * The record that binds an account to an organization with a role. Every
 * function here is scoped by `organizationId`, its first parameter — there is
 * no exception in this file.
 *
 * `grantMembershipRole` (ENRL-5) is additive, not a replacement for
 * `createMembership`/`updateMembershipRole` above: those two stay exactly
 * as every existing caller found them (including the founding-owner write
 * `accounts.ts#createAccount` makes inline, which records no grantor — see
 * `schema.ts`'s own comment on `grantedByAccountId`), and
 * `grantMembershipRole` is the one path that stamps who granted a role,
 * for `@bloombot/actions`' `memberships.grant` action to call.
 */

import { and, eq } from 'drizzle-orm'

import type { Database } from '../client.js'
import { memberships, type MembershipRole } from '../schema.js'

export type Membership = typeof memberships.$inferSelect
export type { MembershipRole }

/**
 * Add an existing account to an organization with a role.
 *
 * For a brand-new account's first membership, use
 * `accounts.createAccount` instead — it creates the account and this record
 * together, atomically. This is for a second membership: inviting an
 * account that already exists into another organization, or adding a second
 * instructor or a teaching assistant to one it is already in (TEN-1).
 */
export function createMembership(
  organizationId: string,
  accountId: string,
  role: MembershipRole,
  db: Database
): Membership {
  return db
    .insert(memberships)
    .values({ organizationId, accountId, role, createdAt: Date.now() })
    .returning()
    .get()
}

/** The membership binding `accountId` to `organizationId`, if any. */
export function getMembership(
  organizationId: string,
  accountId: string,
  db: Database
): Membership | undefined {
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.accountId, accountId)
      )
    )
    .get()
}

/** Every membership in an organization. */
export function listMembershipsForOrganization(
  organizationId: string,
  db: Database
): Membership[] {
  return db
    .select()
    .from(memberships)
    .where(eq(memberships.organizationId, organizationId))
    .all()
}

/**
 * Every membership `accountId` holds, across every organization it belongs
 * to.
 *
 * TEN-2 exception, the same class as `accounts.ts#getAccountByEmail`: an
 * account is not scoped to one organization — it can hold a membership in
 * several — so this is organization-independent by design, keyed on
 * `accountId` rather than `organizationId`, and allowlisted in
 * `tests/tenant-scoping-convention.test.ts` accordingly. `apps/api`'s
 * `GET /auth/me` is the first caller: every action URL is
 * `POST /organizations/:organizationId/actions/:name`, so a signed-in
 * caller needs a way to discover which organization ids it may use there.
 */
export function listMembershipsForAccount(
  accountId: string,
  db: Database
): Membership[] {
  return db
    .select()
    .from(memberships)
    .where(eq(memberships.accountId, accountId))
    .all()
}

/**
 * Change an existing membership's role.
 *
 * Returns the number of rows changed — `0` rather than a different
 * organization's membership when `organizationId` does not match.
 */
export function updateMembershipRole(
  organizationId: string,
  accountId: string,
  role: MembershipRole,
  db: Database
): number {
  const result = db
    .update(memberships)
    .set({ role })
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.accountId, accountId)
      )
    )
    .run()
  return result.changes
}

/**
 * Remove a membership.
 *
 * Returns the number of rows changed — `0` rather than a different
 * organization's membership when `organizationId` does not match.
 */
export function deleteMembership(
  organizationId: string,
  accountId: string,
  db: Database
): number {
  const result = db
    .delete(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.accountId, accountId)
      )
    )
    .run()
  return result.changes
}

/** Fields `@bloombot/actions`' `memberships.grant` action supplies. */
export interface GrantMembershipInput {
  accountId: string
  role: MembershipRole
  /** The owner performing the grant (ENRL-5) — never the account being granted a role; the action's own execute is what refuses a caller granting themselves one. */
  grantedByAccountId: string
}

/**
 * ENRL-5: grant a role, creating the membership if `accountId` holds none in
 * `organizationId` yet, or changing an existing one's role — either way,
 * `grantedByAccountId` and `grantedAt` are stamped on the row, so a staff
 * role is never traceless (see `schema.ts`'s own comment on the two
 * columns). *Who* may call this — only an existing owner, and never on
 * themselves — is `@bloombot/actions`' `memberships.grant` action's own
 * check, not this function's: this file has no notion of a "caller",
 * only of the organization the write is scoped to, the same division
 * `courseInstructionRevisions.createRevision` draws from
 * `courseInstructions.save`'s own `requireAccountId` check.
 */
export function grantMembershipRole(
  organizationId: string,
  input: GrantMembershipInput,
  db: Database
): Membership {
  const existing = getMembership(organizationId, input.accountId, db)
  const grantedAt = Date.now()

  if (existing) {
    const updated = db
      .update(memberships)
      .set({
        role: input.role,
        grantedByAccountId: input.grantedByAccountId,
        grantedAt,
      })
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.accountId, input.accountId)
        )
      )
      .returning()
      .get()
    // `existing` just proved this row was there; `updated` is only
    // `undefined` if a concurrent writer removed it in between (D-11's own
    // "a write whose own WHERE re-checks the condition its read relied on"
    // reasoning) — falls through to the insert below, treating that race
    // exactly like "no membership existed yet".
    if (updated) return updated
  }

  return db
    .insert(memberships)
    .values({
      organizationId,
      accountId: input.accountId,
      role: input.role,
      grantedByAccountId: input.grantedByAccountId,
      grantedAt,
      createdAt: grantedAt,
    })
    .returning()
    .get()
}
