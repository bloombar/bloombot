/**
 * Repository for `discord_server_bindings` (TEN-3, TEN-6).
 *
 * The record that binds one Discord server to one organization. The
 * snowflake is the table's primary key (see `schema.ts`), so a second
 * `INSERT` for an already-bound server is refused by SQLite itself before any
 * code in this file runs — TEN-3 holds even if a future caller bypasses these
 * functions and writes to the table directly.
 */

import { and, eq, isNull } from 'drizzle-orm'

import type { Database } from '../client.js'
import { discordServerBindings } from '../schema.js'

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
 * Three outcomes, in order:
 *  - the snowflake has never been bound: insert a fresh binding.
 *  - it was bound and later removed (TEN-6, `removed_at` set): re-bind it to
 *    `organizationId`, which may or may not be who held it before (TEN-3
 *    explicitly allows re-claiming a released server).
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
  const existing = db
    .select()
    .from(discordServerBindings)
    .where(eq(discordServerBindings.serverId, input.serverId))
    .get()

  if (!existing) {
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
  }

  if (existing.removedAt === null) {
    return existing.organizationId === organizationId ? existing : undefined
  }

  // TEN-3 / TEN-6: a released binding can be re-claimed by any organization.
  return db
    .update(discordServerBindings)
    .set({
      organizationId,
      installedByAccountId: input.installedByAccountId,
      installedAt: Date.now(),
      removedAt: null,
    })
    .where(eq(discordServerBindings.serverId, input.serverId))
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
