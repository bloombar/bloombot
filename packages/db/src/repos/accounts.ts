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

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import type { Database, Executor, TransactingExecutor } from '../client.js'
import { writeTransaction } from '../client.js'
import { accounts, memberships, type MembershipRole } from '../schema.js'
import { revokeAllSessionsForAccount } from './sessions.js'

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
 *
 * `db` accepts `Executor`, not just `Database`: `@bloombot/auth`'s
 * `sign-in.ts` calls this from inside its own transaction, deciding whether
 * a sign-in is first-time or returning before it writes anything.
 */
export function getAccountByEmail(
  email: string,
  db: Executor
): Account | undefined {
  // DATA-9 — a soft-deleted account is invisible to sign-in exactly the way
  // a disabled one already refuses it, one step earlier: it cannot even be
  // found by the address that used to reach it.
  return db
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.email, email.toLowerCase()), isNull(accounts.deletedAt))
    )
    .get()
}

/**
 * Look up an account by id, with no organization scoping at all — the same
 * TEN-2 exception `getAccountByEmail` already is, for the identical reason:
 * `apps/api`'s own `GET /auth/me` (LINK-6's own "the account signed in")
 * already knows exactly which account a *valid, already-authenticated
 * session* proved, before any organization is in play — scoping this
 * lookup to one would ask the caller to already know something (which
 * organization to check) the session itself does not carry, for a read
 * that discloses nothing beyond what the caller's own session already
 * proved about itself.
 *
 * Also what `routes/admin.ts`'s own `isRequestFromPlatformAdministrator`
 * (ADMIN-4) resolves a session's account through: a platform administrator
 * is not — by ADMIN-4's own text — necessarily a member of the
 * organization an admin-console read or an ADMIN-5 tenant deletion acts
 * on, so `getAccountInOrganization` cannot serve that caller either.
 */
export function getAccountById(
  accountId: string,
  db: Executor
): Account | undefined {
  // DATA-9 — a soft-deleted account answers no question on any surface,
  // including `GET /auth/me`'s own lookup through this function: it reads
  // as though the account does not exist, the same refusal shape a foreign
  // id already gets everywhere else in this package.
  return db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
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
 *
 * `db` accepts `TransactingExecutor`, not just `Database`: called with a
 * top-level connection this opens a real transaction, exactly as before;
 * called with another transaction's own `tx` (`@bloombot/auth`'s
 * `sign-in.ts`, composing a first-time sign-in's organization, account and
 * session atomically — TEN-1) `db.transaction(...)` opens a nested
 * savepoint instead, so a later failure in that outer transaction rolls
 * this back too.
 */
export function createAccount(
  organizationId: string,
  input: NewAccount,
  db: TransactingExecutor
): Account {
  return writeTransaction(db, (tx) => {
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
  return (
    db
      .select({
        id: accounts.id,
        email: accounts.email,
        displayName: accounts.displayName,
        firstName: accounts.firstName,
        lastName: accounts.lastName,
        disabledAt: accounts.disabledAt,
        deletedAt: accounts.deletedAt,
        deletedByAccountId: accounts.deletedByAccountId,
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
      // DATA-9 — a soft-deleted account is invisible here too.
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .get()
  )
}

/**
 * AUTH-7 — fill `firstName`/`lastName` on an account from a Google ID
 * token's claims, the same fill-only rule `@bloombot/db`'s
 * `people.ts#mergeRosterFields` already gives roster fields: a name already
 * stored on the account (from an earlier Google sign-in) is never
 * overwritten, and an omitted claim (`undefined` in `names`) leaves the
 * corresponding column untouched. Returns the account unchanged (no `UPDATE`
 * at all) when neither field is currently `null`, or both incoming values
 * are `undefined` — the ordinary case for an email magic-link sign-in, which
 * never calls this at all, and for a *returning* Google sign-in whose token
 * happens to omit a claim it supplied before. `undefined` when `accountId`
 * does not exist, matching `disableAccount`'s refusal shape.
 */
export function setAccountNames(
  accountId: string,
  names: { firstName?: string; lastName?: string },
  db: TransactingExecutor
): Account | undefined {
  return writeTransaction(db, (tx) => {
    const existing = getAccountById(accountId, tx)
    if (!existing) return undefined

    const patch: Partial<Pick<Account, 'firstName' | 'lastName'>> = {}
    if (existing.firstName === null && names.firstName !== undefined) {
      patch.firstName = names.firstName
    }
    if (existing.lastName === null && names.lastName !== undefined) {
      patch.lastName = names.lastName
    }
    if (Object.keys(patch).length === 0) return existing

    return tx
      .update(accounts)
      .set(patch)
      .where(eq(accounts.id, accountId))
      .returning()
      .get()
  })
}

/**
 * ADMIN-10 — one row of `listAccounts`, below: the account itself, plus how
 * many organizations it currently belongs to (an *active* membership — the
 * same "revoked is absent" reading `memberships.getMembership`'s own module
 * comment already establishes for every other caller in this platform).
 * `totalCostMicros` is not computed here — `routes/admin.ts` joins it in
 * from `costLedger.listAccountTotals`, a cost-ledger read this file has no
 * reason to duplicate.
 */
export interface AccountWithOrganizationCount extends Account {
  organizationCount: number
}

/**
 * ADMIN-10: every account on the platform, newest-first — the console's
 * Users screen. TEN-2 exception, the same class `organizations.ts#listTenantDeletions`/
 * `cost-ledger.ts#listOrganizationTotals` already are: a platform
 * administrator's own read, spanning every account by definition, allowlisted
 * in `tests/tenant-scoping-convention.test.ts` accordingly.
 *
 * The organization count is batched in one grouped query over `memberships`
 * rather than one count per account row — the same "batch the fan-out" style
 * `course-approval.ts#listCoursesForApproval` already uses for its own
 * owner-email lookup.
 */
export function listAccounts(db: Database): AccountWithOrganizationCount[] {
  // DATA-9 — a soft-deleted account is gone from the console the same as
  // everywhere else.
  const accountRows = db
    .select()
    .from(accounts)
    .where(isNull(accounts.deletedAt))
    .orderBy(desc(accounts.createdAt))
    .all()

  const membershipCounts = db
    .select({
      accountId: memberships.accountId,
      count: sql<number>`count(*)`,
    })
    .from(memberships)
    .where(isNull(memberships.revokedAt))
    .groupBy(memberships.accountId)
    .all()
  const countByAccountId = new Map(
    membershipCounts.map((row) => [row.accountId, Number(row.count)])
  )

  return accountRows.map((row) => ({
    ...row,
    organizationCount: countByAccountId.get(row.id) ?? 0,
  }))
}

/**
 * Disable an account and revoke every session it holds, atomically (finding
 * 3 of the AUTH-1..4 rework: `disabled_at` is the platform's
 * suspend-without-deleting control, and it must not be possible to set it
 * without also ending whatever sessions are already live — an operator
 * disabling a compromised account cannot be left to remember a second call).
 *
 * TEN-2 exception, the same class as `getAccountByEmail`: `disabled_at`
 * lives on `accounts`, not `memberships`, so this is not scoped to one
 * organization — it is an account-wide suspension, not a per-tenant one.
 * (Do not add an `organizationId` parameter here that is only used for a
 * membership pre-check ahead of an unscoped `UPDATE`;
 * `tests/tenant-scoping-convention.test.ts` documents exactly that shape as
 * the mistake to avoid.)
 *
 * Returns the disabled account, or `undefined` if no account has this id.
 */
export function disableAccount(
  accountId: string,
  db: TransactingExecutor
): Account | undefined {
  return writeTransaction(db, (tx) => {
    const account = tx
      .update(accounts)
      .set({ disabledAt: Date.now() })
      .where(eq(accounts.id, accountId))
      .returning()
      .get()
    if (!account) return undefined
    revokeAllSessionsForAccount(accountId, tx)
    return account
  })
}

/**
 * DATA-7 — soft-delete an account: stamp `deletedAt`/`deletedByAccountId`
 * rather than removing the row. An account has no child table in this
 * package's own deletable set (`schema.ts`'s module comment on the six
 * deletable kinds — none of `people`/`conversations`/`courses`/`projects`/
 * `organizations` carries an `accountId` foreign key), so there is nothing
 * for this to cascade to; it is a leaf in DATA-7's own cascade.
 *
 * Sessions are deliberately left alone here, unlike `disableAccount`'s own
 * `revokeAllSessionsForAccount`: who may call this, and whether it also ends
 * a live session, is the action layer's own policy decision (out of this
 * slice's scope — see the brief), not something a repo function decides for
 * every future caller.
 *
 * `undefined` when `accountId` does not exist, or is already deleted — a
 * second delete is not a re-stamp, the same "idempotent, not incremental"
 * refusal shape `archiveProject`'s own `archivedAt IS NULL` condition
 * gives, one table over.
 */
export function softDeleteAccount(
  accountId: string,
  deletedByAccountId: string,
  db: Database
): Account | undefined {
  return db
    .update(accounts)
    .set({ deletedAt: Date.now(), deletedByAccountId })
    .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
    .returning()
    .get()
}

/**
 * DATA-7 — restore a soft-deleted account: clear both tombstone columns.
 * `undefined` when `accountId` does not exist, or is not currently deleted —
 * restoring an account that was never deleted is refused, not a silent
 * no-op, the same "nothing to restore" refusal `softDeleteAccount` above
 * gives its own mirror case.
 *
 * Reads with no `deletedAt` filter (the DATA-9 convention test's own named
 * exception for a restore path) — a restore has to find exactly the
 * tombstoned row it is meant to un-mark, which every other read in this
 * file exists to hide.
 */
export function restoreAccount(
  accountId: string,
  db: Database
): Account | undefined {
  return db
    .update(accounts)
    .set({ deletedAt: null, deletedByAccountId: null })
    .where(and(eq(accounts.id, accountId), isNotNull(accounts.deletedAt)))
    .returning()
    .get()
}
