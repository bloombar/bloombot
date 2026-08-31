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

import type { Database } from '../client.js'
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
 */
export function createOrganization(
  organizationId: string,
  input: NewOrganization,
  db: Database
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

/** Look up an organization by its own id. `undefined` if it does not exist. */
export function getOrganizationById(
  organizationId: string,
  db: Database
): Organization | undefined {
  return db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()
}
