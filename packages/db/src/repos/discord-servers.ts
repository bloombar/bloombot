/**
 * Repository for `discord_server_bindings` (TEN-3, TEN-6).
 *
 * The record that binds one Discord server to one organization. The
 * snowflake is the table's primary key (see `schema.ts`), so a second
 * `INSERT` for an already-bound server is refused by SQLite itself before any
 * code in this file runs — TEN-3 holds even if a future caller bypasses these
 * functions and writes to the table directly.
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import type { Database } from '../client.js'
import { discordServerBindings } from '../schema.js'
import { getMembership } from './memberships.js'

export type DiscordServerBinding = typeof discordServerBindings.$inferSelect

/**
 * Resolve a Discord server's snowflake to its active binding.
 *
 * TEN-2 exception #2: unscoped by design. This *is* the lookup that
 * establishes which organization an incoming Discord message belongs to, so
 * it cannot itself take an organization id — nothing has determined one yet.
 * A removed binding (TEN-6: `removed_at` set) resolves to `undefined`, the
 * same as a server that was never bound: the bot has left, so no organization
 * owns this server's messages any more.
 */
export function resolveDiscordServerBinding(
  serverId: string,
  db: Database
): DiscordServerBinding | undefined {
  return db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.serverId, serverId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .get()
}

/** Fields the caller supplies when claiming a Discord server. */
export interface ClaimDiscordServer {
  serverId: string
  installedByAccountId: string
}

/**
 * Claim a Discord server for an organization.
 *
 * Refused, up front: `installedByAccountId` is not a member of
 * `organizationId` — the foreign key only proves the account exists
 * *somewhere*, not that it administers *this* organization, and a foreign
 * tenant's account must not be recordable as the installer. (This is only
 * the data-layer half of TEN-4's fuller "verify the account actually
 * administers the Discord server" check, which belongs to the phase with
 * the OAuth flow.)
 *
 * Otherwise, three outcomes:
 *  - the snowflake has never been bound: insert a fresh binding. If a
 *    concurrent claim wins the race, SQLite's primary key refuses the second
 *    insert; that failure is caught here and reported the same way as any
 *    other "already claimed elsewhere" outcome — `undefined`, not a thrown
 *    driver error a caller would have to pattern-match on.
 *  - it was bound and later removed (TEN-6, `removed_at` set): re-bind it to
 *    `organizationId`, which may or may not be who held it before (TEN-3
 *    explicitly allows re-claiming a released server). The `UPDATE` repeats
 *    `removed_at IS NULL` — the same condition that qualified `existing` — so
 *    a concurrent claim that re-binds the row first makes this one a no-op
 *    rather than a silent second write to a binding that is actively bound
 *    again by the time this statement runs; the loser gets `undefined`.
 *  - it is actively bound (`removed_at` is null) to a *different*
 *    organization: refused — returns `undefined` rather than throwing,
 *    because "already claimed elsewhere" is a routine outcome an installer
 *    flow needs to handle, not an exceptional one. Actively bound to the same
 *    organization already is idempotent: the existing binding is returned
 *    unchanged.
 */
export function claimDiscordServerBinding(
  organizationId: string,
  input: ClaimDiscordServer,
  db: Database
): DiscordServerBinding | undefined {
  // TEN-4 (data-layer half): the installer must actually belong to the
  // organization claiming the server.
  if (!getMembership(organizationId, input.installedByAccountId, db)) {
    return undefined
  }

  const existing = db
    .select()
    .from(discordServerBindings)
    .where(eq(discordServerBindings.serverId, input.serverId))
    .get()

  if (!existing) {
    try {
      return db
        .insert(discordServerBindings)
        .values({
          serverId: input.serverId,
          organizationId,
          installedByAccountId: input.installedByAccountId,
          installedAt: Date.now(),
        })
        .returning()
        .get()
    } catch (error) {
      // A concurrent insert claimed this snowflake first: SQLite's primary
      // key on `server_id` refuses the second insert. Report it the same way
      // as every other "already claimed elsewhere" outcome, not as a thrown
      // driver error the caller has to recognise by string.
      if (
        error instanceof BetterSqlite3.SqliteError &&
        error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
      ) {
        return undefined
      }
      throw error
    }
  }

  if (existing.removedAt === null) {
    return existing.organizationId === organizationId ? existing : undefined
  }

  // TEN-3 / TEN-6: a released binding can be re-claimed by any organization.
  // `removed_at IS NULL` here — not just `server_id = ?` — makes this a
  // single conditional write: a concurrent claim that re-binds the row
  // between the `SELECT` above and this `UPDATE` makes the row no longer
  // match, so `.get()` returns no row and this caller is refused rather than
  // silently overwriting the winner's binding.
  return db
    .update(discordServerBindings)
    .set({
      organizationId,
      installedByAccountId: input.installedByAccountId,
      installedAt: Date.now(),
      removedAt: null,
    })
    .where(
      and(
        eq(discordServerBindings.serverId, input.serverId),
        isNotNull(discordServerBindings.removedAt)
      )
    )
    .returning()
    .get()
}

/**
 * Mark a binding removed (TEN-6). Never deletes the row — a re-installation
 * must be able to see who held the server before, and `claimDiscordServerBinding`
 * needs the row to exist to re-claim it.
 *
 * Returns the number of rows changed: `0` when the server is not bound at
 * all, already removed, or bound to a *different* organization — an
 * organization can only remove its own binding.
 */
export function removeDiscordServerBinding(
  organizationId: string,
  serverId: string,
  db: Database
): number {
  const result = db
    .update(discordServerBindings)
    .set({ removedAt: Date.now() })
    .where(
      and(
        eq(discordServerBindings.serverId, serverId),
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .run()
  return result.changes
}

/**
 * The active binding for `serverId`, scoped to `organizationId` —
 * `undefined` both when no such binding exists and when it exists but
 * belongs to a different organization (TEN-5) or has already been removed
 * (TEN-6). Unlike `resolveDiscordServerBinding` above (TEN-2 exception #2,
 * organization-independent by necessity — nothing has determined an
 * organization yet at that point), this is reached only once an
 * organization is already known — `@bloombot/actions`'
 * `discordServers.remove`'s own policy — so it takes one, the convention
 * every other function in this file but that one holds itself to.
 */
export function getActiveDiscordServerBinding(
  organizationId: string,
  serverId: string,
  db: Database
): DiscordServerBinding | undefined {
  return db
    .select()
    .from(discordServerBindings)
    .where(
      and(
        eq(discordServerBindings.serverId, serverId),
        eq(discordServerBindings.organizationId, organizationId),
        isNull(discordServerBindings.removedAt)
      )
    )
    .get()
}

/** Every binding — active or removed — an organization has ever held. */
export function listDiscordServerBindingsForOrganization(
  organizationId: string,
  db: Database
): DiscordServerBinding[] {
  return db
    .select()
    .from(discordServerBindings)
    .where(eq(discordServerBindings.organizationId, organizationId))
    .all()
}
