/**
 * Repository for `organizations` — the tenant itself (TEN-1).
 *
 * An organization is not a record scoped *by* another organization the way
 * `memberships` or `discord_server_bindings` are; it is the thing everything
 * else is scoped to. Every function still takes the organization id as its
 * first parameter, so the convention `src/repos/**` is checked against holds
 * even here: the id is simply the organization's own.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import { writeTransaction } from '../client.js'
import {
  contentDeletions,
  conversations,
  costLedgerEntries,
  courseApprovalEvents,
  courseAttachments,
  courseCategories,
  courseChannels,
  courseInstructionRevisions,
  courseJoinLinks,
  courseSelfEnrolmentIntents,
  courseWebSources,
  courses,
  discordInstallStates,
  discordServerBindings,
  enrolments,
  jobs,
  memberships,
  membershipInvitations,
  messages,
  organizations,
  people,
  personIdentities,
  personLinkChallenges,
  projects,
  rosterChannelAssignments,
  rosterImportAcknowledgements,
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
  // DATA-9 — a soft-deleted organization cannot be opened at its own
  // address.
  return db
    .select()
    .from(organizations)
    .where(
      and(eq(organizations.id, organizationId), isNull(organizations.deletedAt))
    )
    .get()
}

/**
 * WEB-57: rename an organization — the name itself, and nothing else on
 * the row. `name` is expected to already be validated and trimmed by the
 * caller (`@bloombot/actions`' `organizations.rename` action) — this
 * function does no trimming or blank-checking of its own, the same "a repo
 * function reads and writes the database; validation is the action layer's
 * job" split every other repo in this directory already holds itself to
 * (`organizations.ts`'s own module comment). `undefined` when
 * `organizationId` does not exist — the same "cannot tell you" refusal
 * `setSpendingCap`, immediately below, already gives.
 */
export function renameOrganization(
  organizationId: string,
  name: string,
  db: Database
): Organization | undefined {
  return db
    .update(organizations)
    .set({ name })
    .where(eq(organizations.id, organizationId))
    .returning()
    .get()
}

/**
 * Set (or clear, with `null`) COST-3's spending cap. An audit
 * (`docs/ROADMAP.md`'s "Audit — surfaces that were never built") found this
 * doc comment used to claim "there is no action layer wired to this in this
 * slice ... it exists so a test, or a future admin action, can configure a
 * cap" — true when it was written, and never revisited once it stopped
 * being true. It is wired now: `packages/actions/src/actions/cost-ledger.ts`'s
 * `costLedger.setSpendingCap`, restricted to an organization's own owner,
 * is what an instructor actually calls, converting a currency amount they
 * type into the integer micros this column stores. This function itself
 * still does no conversion and no authorization — the same "policies and
 * roles are the action layer's own job, a repo function only reads and
 * writes the database" split every other repo in this directory holds
 * itself to. `undefined` when `organizationId` does not exist, the same
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
 *
 * DATA-9 exception, named in `tests/soft-delete-convention.test.ts`'s own
 * allowlist: deliberately counts every row regardless of `deletedAt` — this
 * is ADMIN-5's *permanent* wipe, which has to remove a soft-deleted course
 * too, not undercount it because DATA-9's own read filter was built to hide
 * it from the product, not from this operation.
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
  /** ROST-17 — how many students currently have a remembered channel, across every course in this organization. Named alongside `courses`/`people` above (rather than left out with `cost_ledger_entries`/`person_identities`, this doc comment's own list of the deliberately-uncounted) because a remembered channel is a fact about a real, named Discord channel an instructor and a student both recognize — closer to "a course" than to bookkeeping. */
  rosterChannelAssignments: number
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
    rosterChannelAssignments: count(
      db
        .select({ count: sql<number>`count(*)` })
        .from(rosterChannelAssignments)
        .where(eq(rosterChannelAssignments.organizationId, organizationId))
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
  return writeTransaction(db, (tx) => {
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
    // TEN-10 rework finding — `course_self_enrolment_intents` and
    // `course_web_sources` are both real foreign keys to `courses.id` and
    // `organizations.id` (`schema.ts`'s own comment on each), missing from
    // this hand-written list until `tests/organizations-cascade-schema.test.ts`
    // (TEN-10's own schema-derived test) caught it — the same class of drift
    // `roster_channel_assignments` and `content_deletions` were each patched
    // for below, after their own production `FOREIGN KEY constraint failed`.
    // Deleted here, ahead of `courses`, the same "children before the
    // parents they reference" ordering `deletions.ts#emptyCourse` already
    // holds itself to for the identical two tables, one course at a time.
    tx.delete(courseSelfEnrolmentIntents)
      .where(eq(courseSelfEnrolmentIntents.organizationId, organizationId))
      .run()
    tx.delete(courseWebSources)
      .where(eq(courseWebSources.organizationId, organizationId))
      .run()
    // COST-8 — a course's own approval history, the same "does not outlive
    // the course, must not block the delete" carve-out `deletions.ts`'s own
    // `emptyCourse` already gives it, one level up (a whole tenant here,
    // rather than one course).
    tx.delete(courseApprovalEvents)
      .where(eq(courseApprovalEvents.organizationId, organizationId))
      .run()
    // ROST-20 rework finding: `roster_import_acknowledgements` is a real
    // foreign key to `courses.id`, `jobs.id` and `organizations.id` alike
    // (`schema.ts`'s own comment on why none of the three outlive it),
    // deleted here — ahead of `courses`, `jobs` and `organizations` below —
    // the same COST-8 "does not outlive the course, must not block the
    // delete" carve-out `courseApprovalEvents` just above already gets, one
    // level up (a whole tenant here, rather than one course,
    // `deletions.ts#emptyCourse`'s own identical line).
    tx.delete(rosterImportAcknowledgements)
      .where(eq(rosterImportAcknowledgements.organizationId, organizationId))
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
    // ROST-17 — references both `people` and `courses`; deleted here,
    // ahead of either, the same "children before the parents they
    // reference" ordering this function's own doc comment already holds
    // itself to (`foreign_keys = ON` on every connection actually enforces
    // it). Missing this row is exactly why deleting an organization that
    // had ever run a roster import creating a student channel used to
    // throw `FOREIGN KEY constraint failed` on the `people` delete below.
    tx.delete(rosterChannelAssignments)
      .where(eq(rosterChannelAssignments.organizationId, organizationId))
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
    // TEN-10 rework finding — `membership_invitations` is a real foreign key
    // to `organizations.id` (`schema.ts`'s own comment), the third table this
    // hand-written list had drifted from missing. Deleted here, alongside
    // `memberships` above, for the same reason: an invitation is the same
    // "join between an account and this organization" `memberships` already
    // is, just not yet redeemed.
    tx.delete(membershipInvitations)
      .where(eq(membershipInvitations.organizationId, organizationId))
      .run()
    // PROJ-8/PROJ-9 rework finding: `content_deletions` is a real foreign
    // key to `organizations.id` (`schema.ts`'s own comment on why it is,
    // unlike this table's own `tenant_deletions`) — any course or project
    // ever deleted in this organization left a row here, and deleting the
    // organization without deleting these first threw `FOREIGN KEY
    // constraint failed` on the `organizations` delete below. Deleted, not
    // preserved: unlike `tenant_deletions` (deliberately outliving the
    // organization it describes, ADMIN-5's own audit trail of *this*
    // operation), a course or project deletion recorded here is a fact
    // about a tenant that, once the tenant itself is gone, has nothing
    // left to be an audit trail *for*.
    tx.delete(contentDeletions)
      .where(eq(contentDeletions.organizationId, organizationId))
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

/**
 * DATA-7 — soft-delete an organization: stamp `deletedAt`/`deletedByAccountId`
 * on the organization itself and, with the *same* timestamp, on every
 * `projects`/`courses`/`people`/`conversations` row it owns — DATA-7's own
 * "deleting a parent marks its children with the same timestamp, and that
 * shared timestamp is what a restore reads". Every one of those tables
 * already carries `organizationId` directly, so the cascade is a flat
 * per-table `UPDATE ... WHERE organizationId = X AND deletedAt IS NULL`
 * rather than a walk through `projects → courses → conversations` — no
 * table here needs another to find its own rows. Skips a row that is
 * already deleted (`deletedAt IS NULL` in each cascade write) so an earlier,
 * independent deletion — a course deleted on its own last week, say — keeps
 * its own, earlier timestamp rather than being silently re-stamped to this
 * one, which is exactly what would make `restoreOrganization`'s own
 * "only children marked at the same moment" rule restore something that was
 * deleted on purpose, before this call ever ran.
 *
 * Distinct from ADMIN-5's `deleteOrganizationData`, which still physically
 * removes every row outright — this function marks, `deleteOrganizationData`
 * removes; this slice does not connect the two (DATA-8's sweep, a later
 * slice, is what eventually calls something like it for what this leaves
 * behind once the retention window passes).
 *
 * `undefined` when `organizationId` does not exist, or is already deleted.
 */
export function softDeleteOrganization(
  organizationId: string,
  deletedByAccountId: string,
  db: Database
): Organization | undefined {
  return writeTransaction(db, (tx) => {
    const now = Date.now()
    const organization = tx
      .update(organizations)
      .set({ deletedAt: now, deletedByAccountId })
      .where(
        and(
          eq(organizations.id, organizationId),
          isNull(organizations.deletedAt)
        )
      )
      .returning()
      .get()
    if (!organization) return undefined

    const cascade = { deletedAt: now, deletedByAccountId }
    tx.update(projects)
      .set(cascade)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt)
        )
      )
      .run()
    tx.update(courses)
      .set(cascade)
      .where(
        and(
          eq(courses.organizationId, organizationId),
          isNull(courses.deletedAt)
        )
      )
      .run()
    tx.update(people)
      .set(cascade)
      .where(
        and(eq(people.organizationId, organizationId), isNull(people.deletedAt))
      )
      .run()
    tx.update(conversations)
      .set(cascade)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          isNull(conversations.deletedAt)
        )
      )
      .run()

    return organization
  })
}

/**
 * DATA-7 — restore a soft-deleted organization: read its own `deletedAt`
 * first (unfiltered by `deletedAt` — the DATA-9 convention test's own named
 * "a restore" exception, needed here to learn the exact shared timestamp to
 * restore children by), then un-mark every `projects`/`courses`/`people`/
 * `conversations` row that carries that *same* timestamp — never a child
 * deleted independently, before or after this organization's own delete,
 * which is DATA-7's own "something deleted earlier, on purpose, stays
 * deleted".
 *
 * `undefined` when `organizationId` does not exist, or is not currently
 * deleted.
 */
export function restoreOrganization(
  organizationId: string,
  db: Database
): Organization | undefined {
  return writeTransaction(db, (tx) => {
    const existing = tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .get()
    if (!existing || existing.deletedAt === null) return undefined
    const deletedAt = existing.deletedAt

    const restored = { deletedAt: null, deletedByAccountId: null }
    tx.update(projects)
      .set(restored)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          eq(projects.deletedAt, deletedAt)
        )
      )
      .run()
    tx.update(courses)
      .set(restored)
      .where(
        and(
          eq(courses.organizationId, organizationId),
          eq(courses.deletedAt, deletedAt)
        )
      )
      .run()
    tx.update(people)
      .set(restored)
      .where(
        and(
          eq(people.organizationId, organizationId),
          eq(people.deletedAt, deletedAt)
        )
      )
      .run()
    tx.update(conversations)
      .set(restored)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.deletedAt, deletedAt)
        )
      )
      .run()

    return tx
      .update(organizations)
      .set(restored)
      .where(
        and(
          eq(organizations.id, organizationId),
          eq(organizations.deletedAt, deletedAt)
        )
      )
      .returning()
      .get()
  })
}
