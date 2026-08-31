/**
 * Repository for `accounts` (TEN-1, TEN-2).
 *
 * An account is a sign-in identity, not a record scoped to one organization —
 * the same account can belong to several, through `memberships`. Every
 * function here is therefore reached *through* an organization (its first
 * parameter), except `getAccountByEmail`: the one documented TEN-2 exception,
 * because an account has to be found before any organization is known — it is
 * how sign-in decides whether this is a returning account or a new one.
 */

import { and, eq } from 'drizzle-orm'

import type { Database } from '../client.js'
import { accounts, memberships, type MembershipRole } from '../schema.js'

export type Account = typeof accounts.$inferSelect

/** Fields the caller supplies when creating an account. */
export interface NewAccount {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  email: string
  displayName: string
  /** The role the new membership in `organizationId` is created with. */
  role: MembershipRole
}

/**
 * Look up an account by email address, case-insensitively.
 *
 * TEN-2 exception #1: unscoped by design. An account exists before any
 * organization does, so this is how sign-in and invitation flows find an
 * existing account without already knowing which organization it belongs to.
 */
export function getAccountByEmail(
  email: string,
  db: Database
): Account | undefined {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.email, email.toLowerCase()))
    .get()
}

/**
 * Create a new account and its first membership, atomically.
 *
 * `organizationId` is the organization the account joins immediately — a
 * fresh personal organization on sign-up (TEN-1), or an existing one when an
 * instructor invites a new teaching assistant by email. An account that
 * belongs to more than one organization already exists; give it a second
 * membership with `memberships.createMembership` instead of calling this
 * again.
 */
export function createAccount(
  organizationId: string,
  input: NewAccount,
  db: Database
): Account {
  return db.transaction((tx) => {
    const account = tx
      .insert(accounts)
      .values({
        id: input.id ?? crypto.randomUUID(),
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        createdAt: Date.now(),
      })
      .returning()
      .get()

    tx.insert(memberships)
      .values({
        organizationId,
        accountId: account.id,
        role: input.role,
        createdAt: Date.now(),
      })
      .run()

    return account
  })
}

/**
 * Look up an account by id, scoped to a membership in `organizationId`.
 *
 * `undefined` both when the account does not exist and when it exists but is
 * not a member of this organization (TEN-5) — the two cases are
 * indistinguishable on purpose.
 */
export function getAccountInOrganization(
  organizationId: string,
  accountId: string,
  db: Database
): Account | undefined {
  return db
    .select({
      id: accounts.id,
      email: accounts.email,
      displayName: accounts.displayName,
      disabledAt: accounts.disabledAt,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .innerJoin(
      memberships,
      and(
        eq(memberships.accountId, accounts.id),
        eq(memberships.organizationId, organizationId)
      )
    )
    .where(eq(accounts.id, accountId))
    .get()
}

/**
 * Disable an account, scoped to a membership in `organizationId`.
 *
 * Returns the number of rows changed: `1` on success, `0` both when the
 * account does not exist and when it is not a member of this organization —
 * an organization can never disable an account it has no relationship to,
 * and it cannot tell the difference between those two cases either (TEN-5).
 */
export function disableAccountInOrganization(
  organizationId: string,
  accountId: string,
  db: Database
): number {
  const member = db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.accountId, accountId)
      )
    )
    .get()
  if (!member) return 0

  const result = db
    .update(accounts)
    .set({ disabledAt: Date.now() })
    .where(eq(accounts.id, accountId))
    .run()
  return result.changes
}
