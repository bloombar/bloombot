/**
 * Repository for `organizations` — the tenant itself (TEN-1).
 *
 * An organization is not a record scoped *by* another organization the way
 * `memberships` or `discord_server_bindings` are; it is the thing everything
 * else is scoped to. Every function still takes the organization id as its
 * first parameter, so the convention `src/repos/**` is checked against holds
 * even here: the id is simply the organization's own.
 */

import { eq } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import { organizations } from '../schema.js'

export type Organization = typeof organizations.$inferSelect

/** Fields the caller supplies when creating an organization. */
export interface NewOrganization {
  name: string
  /** TEN-1: an account's own organization, created for it on sign-up. */
  isPersonal: boolean
}

/**
 * Create an organization with the given id.
 *
 * The id is supplied by the caller (typically `crypto.randomUUID()`) rather
 * than generated here, the same way every other repo in this package takes
 * its scoping id as an argument instead of inventing one — it keeps id
 * generation in one place (the caller) regardless of which table is involved.
 *
 * `db` accepts `Executor`, not just `Database`: `@bloombot/auth`'s
 * `sign-in.ts` calls this from inside its own transaction, creating a
 * first-time sign-in's personal organization atomically with its account
 * and membership (TEN-1).
 */
export function createOrganization(
  organizationId: string,
  input: NewOrganization,
  db: Executor
): Organization {
  return db
    .insert(organizations)
    .values({
      id: organizationId,
      name: input.name,
      isPersonal: input.isPersonal,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * Look up an organization by its own id. `undefined` if it does not exist.
 *
 * `db` accepts `Executor`, not just `Database` (rework, LINK-9's own
 * healing path): `@bloombot/auth`'s `sign-in.ts` calls this from inside
 * its own transaction to find a returning account's personal organization,
 * the same reason `createOrganization`'s own doc comment already gives.
 */
export function getOrganizationById(
  organizationId: string,
  db: Executor
): Organization | undefined {
  return db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()
}

/**
 * Set (or clear, with `null`) COST-3's spending cap. There is no action
 * layer wired to this in this slice (the brief for COST-1..6 excludes the
 * admin console this would eventually be set from) — it exists so a test,
 * or a future admin action, can configure a cap without reaching for raw
 * SQL. `undefined` when `organizationId` does not exist, the same
 * "cannot tell you" refusal every other lookup in this file gives.
 */
export function setSpendingCap(
  organizationId: string,
  spendingCapMicros: number | null,
  db: Database
): Organization | undefined {
  return db
    .update(organizations)
    .set({ spendingCapMicros })
    .where(eq(organizations.id, organizationId))
    .returning()
    .get()
}
