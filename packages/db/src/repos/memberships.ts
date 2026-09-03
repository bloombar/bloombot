/**
 * Repository for `memberships` (TEN-1, TEN-2).
 *
 * The record that binds an account to an organization with a role. Every
 * function here is scoped by `organizationId`, its first parameter — there is
 * no exception in this file.
 *
 * `grantMembershipRole` (ENRL-5) is additive to `createMembership` above,
 * which stays exactly as every existing caller found it (including the
 * founding-owner write `accounts.ts#createAccount` makes inline, which
 * records no grantor — see `schema.ts`'s own comment on
 * `grantedByAccountId`); `grantMembershipRole` is the one path that stamps
 * who granted a role, for `@bloombot/actions`' `memberships.grant` action to
 * call. Rework finding, "cheap-fix": this file used to also export a plain
 * `updateMembershipRole`, changing a role without stamping either column —
 * a caller of it left `grantedByAccountId`/`grantedAt` describing a *wrong*
 * grantor (whoever the row's columns already held, if any) rather than an
 * honestly absent one, for a role that in fact just changed. It had no
 * caller outside its own tests, so it was removed rather than fixed:
 * `grantMembershipRole` already covers "change an existing membership's
 * role" (its own `existing` branch) and always stamps both columns
 * correctly, so there is no longer a plain role-change path a future caller
 * could reach for by mistake.
 *
 * `revokeMembership` (ENRL-11) is the removal D-67/D-68 both left open,
 * closed here rather than in `@bloombot/actions`: it *marks* a membership
 * revoked (`revokedByAccountId`/`revokedAt`, `schema.ts`) rather than
 * deleting the row `deleteMembership`, below, would — see that function's
 * own doc comment for why. `getMembership`, `listMembershipsForOrganization`
 * and `listMembershipsForAccount` all now exclude a revoked row from their
 * own `WHERE`, so revoking is not a fact a caller elsewhere in the platform
 * has to separately learn to check for: every one of the many call sites
 * that already ask "does this account have a membership here" (`apps/api`'s
 * `routes/actions.ts`/`chat.ts`/`discord-servers.ts`/`transcript-exports.ts`,
 * `apps/mcp`'s `authenticate.ts`/`call-tool.ts`, this package's own
 * `discord-servers.ts`, and every action in `@bloombot/actions` that checks
 * a caller's own role) gets "a revoked membership is absent" for free,
 * with no change to any of them. `grantMembershipRole`'s own `existing`
 * check is the one place in this file that deliberately does *not* use
 * `getMembership` for that reason — see its own comment, below.
 */

import { and, eq, isNull } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
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

/**
 * The *active* membership binding `accountId` to `organizationId`, if any —
 * `undefined` for an account that never held one here, and, since ENRL-11,
 * for one that did and was revoked (`revokedAt`, `schema.ts`): the two are
 * deliberately indistinguishable through this function, the same TEN-5
 * "not-found rather than a different refusal" shape every other absence in
 * this platform already gives. This is the function nearly every
 * authorization check in the platform calls to answer "does this account
 * currently have any standing in this organization" — this file's own
 * module comment lists the callers — so filtering the revoked case out
 * *here* is what makes ENRL-11's own "the holder can no longer do what
 * that role permitted" true everywhere at once, with nothing downstream
 * needing to know a `revokedAt` column exists at all.
 *
 * `db` accepts `Executor`, not just `Database` (rework, the same
 * "called from inside another transaction" widening
 * `listMembershipsForAccount`'s own comment already gives, LINK-9's own
 * healing path): `repos/membership-invitations.ts#redeemMembershipInvitation`
 * (ENRL-10) calls this from inside its own transaction, deciding whether a
 * redeemer already holds a membership before granting a role from the
 * invitation it is redeeming — a previously revoked redeemer reads as
 * having none, so an invitation can bring them back in exactly as it would
 * a stranger (`grantMembershipRole`'s own comment on reactivation, below).
 */
export function getMembership(
  organizationId: string,
  accountId: string,
  db: Executor
): Membership | undefined {
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.accountId, accountId),
        isNull(memberships.revokedAt)
      )
    )
    .get()
}

/**
 * The row for `(organizationId, accountId)` regardless of whether it is
 * currently revoked. `getMembership`, above, is the question every other
 * caller in this platform asks — "does this account currently have any
 * standing here" — but the composite primary key on `memberships`
 * (`schema.ts`) means a revoked row still occupies that key exactly as an
 * active one does, so `grantMembershipRole`'s own "does a row already exist
 * to update, or does this need an insert" decision has to see it too, or a
 * fresh grant for a previously revoked account would attempt a second
 * `INSERT` against a primary key the revoked row already holds. Module-
 * private: nothing outside `grantMembershipRole` has a reason to tell the
 * two apart.
 */
function findMembershipRow(
  organizationId: string,
  accountId: string,
  db: Executor
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

/**
 * Every *active* membership in an organization — a revoked one is excluded,
 * the same "who currently holds a role" reading `getMembership`'s own
 * comment gives, above. `@bloombot/actions`' `memberships.list` is this
 * function's own caller, and `apps/web`'s `components/Team.tsx` is what an
 * owner reads it through — the roster this returns is "who is staff right
 * now", not a history of who ever was; who revoked whom, and when, is
 * recorded on the row itself (`revokedByAccountId`/`revokedAt`) for
 * whoever has to account for it later, but this function's own callers
 * have never needed a revoked row rendered alongside a live one.
 */
export function listMembershipsForOrganization(
  organizationId: string,
  db: Database
): Membership[] {
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        isNull(memberships.revokedAt)
      )
    )
    .all()
}

/**
 * Every *active* membership `accountId` holds, across every organization it
 * belongs to — a revoked one is excluded, the same reading `getMembership`'s
 * own comment gives, above: `apps/api`'s `GET /auth/me` is this function's
 * first caller, discovering which organizations a signed-in caller may act
 * in (every action URL is `POST /organizations/:organizationId/actions/:name`),
 * and a revoked membership must not still name an organization the caller
 * can no longer do anything in (ENRL-11).
 *
 * TEN-2 exception, the same class as `accounts.ts#getAccountByEmail`: an
 * account is not scoped to one organization — it can hold a membership in
 * several — so this is organization-independent by design, keyed on
 * `accountId` rather than `organizationId`, and allowlisted in
 * `tests/tenant-scoping-convention.test.ts` accordingly.
 */
/**
 * `db` accepts `Executor`, not just `Database` (rework, LINK-9's own
 * healing path): `@bloombot/auth`'s `sign-in.ts` calls this from inside
 * its own transaction to find a *returning* account's personal
 * organization, the same "called from inside another transaction"
 * widening `organizations.ts#createOrganization`'s own doc comment
 * already explains for the identical reason.
 */
export function listMembershipsForAccount(
  accountId: string,
  db: Executor
): Membership[] {
  return db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.accountId, accountId), isNull(memberships.revokedAt))
    )
    .all()
}

/**
 * Remove a membership outright — a hard delete, unlike `revokeMembership`
 * (ENRL-11), below, which marks. This function predates ENRL-11 and stays
 * exactly as it was: uncalled by any production path (D-67's own finding,
 * unchanged by this slice) and kept for whatever a future caller — a full
 * account deletion, say — genuinely needs to be a hard delete rather than a
 * record kept for accountability. `revokeMembership` is what
 * `@bloombot/actions`' `memberships.revoke` action calls; this is not it.
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
 *
 * `db` accepts `Executor`, not just `Database`, for the identical reason
 * `getMembership`'s own comment gives, immediately above:
 * `redeemMembershipInvitation` (ENRL-10) calls this from inside its own
 * transaction, as the write that actually turns a redeemed invitation into
 * a role.
 *
 * ENRL-11: uses `findMembershipRow`, not `getMembership`, to decide whether
 * this is an update or an insert — see that function's own comment for why
 * it has to see a revoked row too. When it does find one, the update below
 * also clears `revokedAt`/`revokedByAccountId`: a fresh grant (an owner
 * re-adding a colleague they, or a predecessor, previously revoked; or an
 * invitation a previously revoked account redeems, `redeemMembershipInvitation`'s
 * own doc comment) reactivates the membership rather than leaving a stale
 * revocation sitting on a row this call just made active again.
 */
export function grantMembershipRole(
  organizationId: string,
  input: GrantMembershipInput,
  db: Executor
): Membership {
  const existing = findMembershipRow(organizationId, input.accountId, db)
  const grantedAt = Date.now()

  if (existing) {
    const updated = db
      .update(memberships)
      .set({
        role: input.role,
        grantedByAccountId: input.grantedByAccountId,
        grantedAt,
        revokedAt: null,
        revokedByAccountId: null,
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

/** Fields `@bloombot/actions`' `memberships.revoke` action supplies. */
export interface RevokeMembershipInput {
  accountId: string
  /** The owner performing the revoke (ENRL-11) — recorded the same way `grantedByAccountId` already is. *Who* may call this, and whether the target may be a peer owner, is `@bloombot/actions`' `memberships.revoke` action's own check, not this function's — the same division `grantMembershipRole`'s own doc comment draws, above. */
  revokedByAccountId: string
}

/**
 * ENRL-11: revoke a membership — marks it (`revokedByAccountId`/`revokedAt`)
 * rather than deleting the row. ENRL-5 already requires a grant be recorded
 * on the row itself, and an institution has the identical need on the way
 * out — deleting would answer neither "who granted this" nor "who revoked
 * it" the moment it ran. `getMembership`'s own comment, above, is what
 * actually makes revoking take effect: every authorization check in the
 * platform already calls it, and it now excludes a revoked row, so nothing
 * downstream of this function has to learn a new column exists.
 *
 * **The last-owner invariant lives here, not in `@bloombot/actions`.** An
 * organization must never end up with no owner (ENRL-11) — enforced in the
 * repo, not the action or the screen offering it, because this is the one
 * place any caller of this function is forced through, today and in the
 * future. The count of active owners and the write that would drop below
 * one run inside a single transaction — the same "narrow the race, don't
 * just document it" discipline `course-join-links.ts#redeemJoinLink`'s own
 * comment already explains — so two concurrent revokes of two different
 * owners cannot both see "more than one left" and both proceed, leaving
 * none.
 *
 * Returns the updated row, or `undefined` for two different reasons a
 * caller cannot tell apart from the return value alone (by design — see
 * `@bloombot/actions`' own `memberships.revoke`, which is what turns the
 * second one into its own distinct refusal): there was no active
 * membership for this pair at all (never existed, the wrong organization —
 * TEN-5 — or already revoked), or revoking the one found would leave the
 * organization with no owner.
 */
export function revokeMembership(
  organizationId: string,
  input: RevokeMembershipInput,
  db: Database
): Membership | undefined {
  return db.transaction((tx) => {
    const target = getMembership(organizationId, input.accountId, tx)
    if (!target) return undefined

    if (target.role === 'owner') {
      const activeOwners = tx
        .select({ accountId: memberships.accountId })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.role, 'owner'),
            isNull(memberships.revokedAt)
          )
        )
        .all()
      // `target` is itself one of these — `<= 1` means it is the only one.
      if (activeOwners.length <= 1) return undefined
    }

    return tx
      .update(memberships)
      .set({
        revokedAt: Date.now(),
        revokedByAccountId: input.revokedByAccountId,
      })
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.accountId, input.accountId),
          isNull(memberships.revokedAt)
        )
      )
      .returning()
      .get()
  })
}
