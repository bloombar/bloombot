/**
 * Repository for `organizations` — the tenant itself (TEN-1).
 *
 * An organization is not a record scoped *by* another organization the way
 * `memberships` or `discord_server_bindings` are; it is the thing everything
 * else is scoped to. Every function still takes the organization id as its
 * first parameter, so the convention `src/repos/**` is checked against holds
 * even here: the id is simply the organization's own.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import {
  conversations,
  costLedgerEntries,
  courseAttachments,
  courseCategories,
  courseChannels,
  courseInstructionRevisions,
  courseJoinLinks,
  courses,
  discordInstallStates,
  discordServerBindings,
  enrolments,
  jobs,
  memberships,
  messages,
  organizations,
  people,
  personIdentities,
  personLinkChallenges,
  projects,
  tenantDeletions,
  transcriptAccessLog,
  transcriptExports,
  usageCounters,
} from '../schema.js'

export type Organization = typeof organizations.$inferSelect
export type TenantDeletion = typeof tenantDeletions.$inferSelect

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

/**
 * ADMIN-5's own "names exactly what will be deleted before it happens" —
 * counts across the categories a person actually recognizes (courses,
 * students, conversations, messages, enrolments, the server binding,
 * knowledge files, and anything still queued), read before anything is
 * touched. `undefined` when `organizationId` does not exist — there is
 * nothing to preview deleting.
 *
 * Deliberately not exhaustive over every table `deleteOrganizationData`
 * below actually empties (`cost_ledger_entries`, `person_identities`,
 * `person_link_challenges`, `discord_install_states` have no count here):
 * this is a confirmation an administrator reads and acts on, not a schema
 * dump — the categories named are the ones a person can recognize losing.
 *
 * `db` accepts `Executor`, not just `Database`: `deleteOrganizationData`
 * below calls this from inside its own transaction, counting exactly what
 * it is about to delete before any of it is gone.
 */
export interface OrganizationDeletionPreview {
  organizationId: string
  organizationName: string
  courses: number
  people: number
  conversations: number
  messages: number
  enrolments: number
  discordServerBindings: number
  courseAttachments: number
  queuedJobs: number
}

export function previewOrganizationDeletion(
  organizationId: string,
  db: Executor
): OrganizationDeletionPreview | undefined {
  const organization = db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get()
  if (!organization) return undefined

  const count = (row: { count: number } | undefined): number => row?.count ?? 0

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    courses: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(courses)
        .where(eq(courses.organizationId, organizationId))
        .get()
    ),
    people: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(people)
        .where(eq(people.organizationId, organizationId))
        .get()
    ),
    conversations: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(conversations)
        .where(eq(conversations.organizationId, organizationId))
        .get()
    ),
    messages: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.organizationId, organizationId))
        .get()
    ),
    enrolments: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(enrolments)
        .where(eq(enrolments.organizationId, organizationId))
        .get()
    ),
    discordServerBindings: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(discordServerBindings)
        .where(eq(discordServerBindings.organizationId, organizationId))
        .get()
    ),
    courseAttachments: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(courseAttachments)
        .where(eq(courseAttachments.organizationId, organizationId))
        .get()
    ),
    queuedJobs: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            inArray(jobs.status, ['pending', 'running'])
          )
        )
        .get()
    ),
  }
}

/**
 * ADMIN-5 — the deliberate, explicit operation that actually removes a
 * tenant's data. Distinct from TEN-6's "removal preserves data" (removing
 * the bot from a Discord server, which deletes nothing): this is the
 * separate action TEN-6's own text names as the one that does.
 *
 * Every organization-scoped table is emptied here, in FK-safe order —
 * children before the parents they reference (`foreign_keys = ON` on every
 * connection, `client.ts`'s own module comment, means SQLite actually
 * enforces this rather than merely preferring it). `people.mergedIntoPersonId`
 * is nulled out before any `people` row is deleted, breaking the table's
 * own self-reference first — without that, deleting a merge survivor and
 * the row that names it as its `mergedIntoPersonId` in the same statement
 * can violate the constraint depending on the order SQLite happens to
 * process the rows.
 *
 * `accounts`, `sessions` and `sign_in_tokens` are untouched on purpose: an
 * account is not scoped to one organization (TEN-1's own "membership is a
 * separate record"), so deleting a tenant must not delete an account that
 * may still belong to another one — only `memberships`, the join between
 * them, is removed here.
 *
 * Returns the same shape `previewOrganizationDeletion` reports, this time
 * counting what was actually removed — what `recordTenantDeletion`'s own
 * `summary` is built from. `undefined` when `organizationId` does not
 * exist; nothing is deleted.
 *
 * This function does not touch `AttachmentStorage` — a course attachment's
 * or a transcript export's own bytes on disk are its caller's
 * responsibility to clean up (the same division `courseAttachments.detach`'s
 * own job handler already draws between the row, which a repo function
 * deletes, and the bytes, which only a caller holding an `AttachmentStorage`
 * can): this file has no dependency on it, the same "policies read the
 * database and nothing else" discipline `packages/actions` already holds
 * itself to.
 */
export function deleteOrganizationData(
  organizationId: string,
  db: Database
): OrganizationDeletionPreview | undefined {
  return db.transaction((tx) => {
    // Read inside this same transaction, before anything below deletes a
    // row it counts, so the summary returned is exactly what this call is
    // about to remove.
    const preview = previewOrganizationDeletion(organizationId, tx)
    if (!preview) return undefined

    // Children first — see this function's own doc comment for the full
    // ordering rationale.
    tx.delete(messages).where(eq(messages.organizationId, organizationId)).run()
    tx.delete(transcriptAccessLog)
      .where(eq(transcriptAccessLog.organizationId, organizationId))
      .run()
    tx.delete(transcriptExports)
      .where(eq(transcriptExports.organizationId, organizationId))
      .run()
    tx.delete(conversations)
      .where(eq(conversations.organizationId, organizationId))
      .run()
    tx.delete(usageCounters)
      .where(eq(usageCounters.organizationId, organizationId))
      .run()
    tx.delete(costLedgerEntries)
      .where(eq(costLedgerEntries.organizationId, organizationId))
      .run()
    tx.delete(courseAttachments)
      .where(eq(courseAttachments.organizationId, organizationId))
      .run()
    tx.delete(courseInstructionRevisions)
      .where(eq(courseInstructionRevisions.organizationId, organizationId))
      .run()
    tx.delete(courseJoinLinks)
      .where(eq(courseJoinLinks.organizationId, organizationId))
      .run()
    tx.delete(enrolments)
      .where(eq(enrolments.organizationId, organizationId))
      .run()
    tx.delete(personLinkChallenges)
      .where(eq(personLinkChallenges.organizationId, organizationId))
      .run()
    tx.delete(personIdentities)
      .where(eq(personIdentities.organizationId, organizationId))
      .run()
    // Break `people`'s own self-reference before deleting any of it (this
    // function's own doc comment).
    tx.update(people)
      .set({ mergedIntoPersonId: null })
      .where(eq(people.organizationId, organizationId))
      .run()
    tx.delete(people).where(eq(people.organizationId, organizationId)).run()
    tx.delete(courseChannels)
      .where(eq(courseChannels.organizationId, organizationId))
      .run()
    tx.delete(courseCategories)
      .where(eq(courseCategories.organizationId, organizationId))
      .run()
    tx.delete(courses).where(eq(courses.organizationId, organizationId)).run()
    tx.delete(projects).where(eq(projects.organizationId, organizationId)).run()
    tx.delete(discordInstallStates)
      .where(eq(discordInstallStates.organizationId, organizationId))
      .run()
    tx.delete(discordServerBindings)
      .where(eq(discordServerBindings.organizationId, organizationId))
      .run()
    tx.delete(jobs).where(eq(jobs.organizationId, organizationId)).run()
    tx.delete(memberships)
      .where(eq(memberships.organizationId, organizationId))
      .run()
    tx.delete(organizations).where(eq(organizations.id, organizationId)).run()

    return preview
  })
}

/** What `recordTenantDeletion` needs beyond the organization's own id and name — captured by its caller (an admin console route), since a repo function has no notion of "the caller performing this write" beyond what it is handed (the same division `memberships.ts#grantMembershipRole`'s own `grantedByAccountId` already draws). */
export interface NewTenantDeletion {
  organizationName: string
  deletedByAccountId: string
  summary: unknown
}

/**
 * ADMIN-5's own audit trail: who deleted which (former) tenant's data, and
 * when — recorded after `deleteOrganizationData` above has already run, so
 * a failed deletion never produces a record claiming one happened.
 *
 * `organizationId` here is a plain value, not a foreign key (`schema.ts`'s
 * own comment on `tenantDeletions`): the organization this describes no
 * longer exists by the time this is called.
 */
export function recordTenantDeletion(
  organizationId: string,
  input: NewTenantDeletion,
  db: Database
): TenantDeletion {
  return db
    .insert(tenantDeletions)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      organizationName: input.organizationName,
      deletedByAccountId: input.deletedByAccountId,
      summary: JSON.stringify(input.summary),
      deletedAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * Every tenant deletion this platform has ever recorded, newest first —
 * the platform-administrator console's own read of ADMIN-5's audit trail.
 *
 * TEN-2 exception (this file's own module comment, and
 * `tests/tenant-scoping-convention.test.ts`'s own allowlist entry): spans
 * every (former) organization by definition, the same class
 * `cost-ledger.ts#listOrganizationTotals` already is for COST-4's
 * platform-wide read.
 */
export function listTenantDeletions(db: Database): TenantDeletion[] {
  return db
    .select()
    .from(tenantDeletions)
    .orderBy(sql`${tenantDeletions.deletedAt} desc`)
    .all()
}
