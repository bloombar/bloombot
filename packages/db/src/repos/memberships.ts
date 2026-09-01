/**
 * Repository for `memberships` (TEN-1, TEN-2).
 *
 * The record that binds an account to an organization with a role. Every
 * function here is scoped by `organizationId`, its first parameter — there is
 * no exception in this file.
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
