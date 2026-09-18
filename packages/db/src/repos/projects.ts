/**
 * Repository for `projects` (PROJ-1, PROJ-2).
 *
 * A project groups a set of courses, typically a term. Every function here
 * is scoped by `organizationId`, its first parameter — there is no
 * exception in this file (TEN-2).
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, eq, inArray, isNull, isNotNull, lte } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import { writeTransaction } from '../client.js'
import { findProjectUnarchiveConflict } from './courses.js'
import type { CourseNameConflict } from './courses.js'
import { conversations, courses, projects } from '../schema.js'

export type Project = typeof projects.$inferSelect

/** Fields the caller supplies when creating a project. */
export interface NewProject {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  name: string
}

/** What a name-collision refusal names: the name, and the project already using it. */
export interface ProjectNameConflict {
  name: string
  conflictingProjectId: string
  message: string
}

export type SaveProjectResult =
  { ok: true; project: Project } | { ok: false; conflict: ProjectNameConflict }

/**
 * `renameProject` and `unarchiveProject` can also produce the state PROJ-3
 * forbids, one level up (`findProjectUnarchiveConflict`,
 * `repos/courses.ts`): unarchiving a project whose courses' names were taken
 * by another course while it was archived. That refusal names a *course*
 * collision, not a project one, so it carries `CourseNameConflict` rather
 * than `ProjectNameConflict`.
 */
export type UnarchiveProjectResult =
  | { ok: true; project: Project }
  | { ok: false; conflict: ProjectNameConflict | CourseNameConflict }

/**
 * `SQLITE_CONSTRAINT_UNIQUE` is what `projects_org_name_active_unique`
 * (`schema.ts`) throws as — the same check `claimDiscordServerBinding`
 * (`repos/discord-servers.ts`) runs for its own primary-key collision,
 * against the code this package's constraints actually raise.
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof BetterSqlite3.SqliteError &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

/**
 * The active (non-archived) project in `organizationId` already using
 * `name`, if any — what a `SQLITE_CONSTRAINT_UNIQUE` on
 * `projects_org_name_active_unique` refuses, named. `excludeProjectId`
 * leaves the project being saved out of its own candidate set, the same
 * reason `findCourseNameConflict` (`repos/courses.ts`) takes one.
 */
function findActiveProjectConflict(
  organizationId: string,
  name: string,
  db: Database,
  excludeProjectId?: string
): ProjectNameConflict | undefined {
  const conflictingProject = db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projects.name, name),
        isNull(projects.archivedAt),
        // DATA-9 — a soft-deleted project is not a candidate conflict here
        // either; the actual "is this name free" invariant lives in the
        // database now, on `projects_org_name_active_unique` (`schema.ts`,
        // DATA-7 rework must-fix 1) — that index's own `WHERE` excludes a
        // soft-deleted row too, so this pre-check and what the index
        // actually enforces agree.
        isNull(projects.deletedAt)
      )
    )
    .all()
    .find((row) => row.id !== excludeProjectId)

  if (!conflictingProject) return undefined
  return {
    name,
    conflictingProjectId: conflictingProject.id,
    message: `Project name "${name}" is already used by another active project in this organization.`,
  }
}

/**
 * Create a project.
 *
 * A project name must be unique within an organization among its
 * non-archived projects — enforced by `projects_org_name_active_unique`
 * (`schema.ts`), a partial unique index, so a colliding insert fails at the
 * database level. Left unhandled here (D-12): unlike `renameProject` and
 * `unarchiveProject`, a fresh id can never have collided with anything
 * before this call, so there is no "was this reused" question a caller
 * needs answered — and this function's many existing callers already treat
 * its return value as a `Project`, not a result to unwrap.
 *
 * `db` accepts `Executor`, not just `Database`: `actions/projects.ts#duplicateProjectAction`
 * (finding 1 of the PROJ-4/5/TEN-7/8 rework) calls this from inside its own
 * transaction, so the new project and every course copied into it commit or
 * roll back together.
 */
export function createProject(
  organizationId: string,
  input: NewProject,
  db: Executor
): Project {
  return db
    .insert(projects)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      name: input.name,
      archivedAt: null,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * ADMIN-8 — a scoped, indexed point lookup — `projects.id` is that table's
 * own primary key — for the one thing `routes/admin.ts#GET /admin/projects/:projectId`
 * actually needs before it can call anything else in this file: which
 * organization a project id belongs to. `undefined` when the id does not
 * exist. The same shape `course-approval.ts#findCourseOrganizationId`
 * already is for the identical reason, one table up — an admin-console
 * route reaches a project directly by id, with no organization already in
 * hand to scope `getProject` by.
 *
 * TEN-2 exception, allowlisted in `tests/tenant-scoping-convention.test.ts`
 * accordingly.
 */
export function findProjectOrganizationId(
  projectId: string,
  db: Database
): string | undefined {
  // DATA-9 — a soft-deleted project cannot be opened at its own address,
  // including through this id-only lookup.
  return db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .get()?.organizationId
}

/** Look up a project by id, scoped to `organizationId`. */
export function getProject(
  organizationId: string,
  projectId: string,
  db: Database
): Project | undefined {
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        // DATA-9 — a soft-deleted project cannot be opened at its own
        // address.
        isNull(projects.deletedAt)
      )
    )
    .get()
}

/**
 * List an organization's projects.
 *
 * Excludes archived projects by default (PROJ-2) — the common case is
 * "what is currently in use" — pass `includeArchived: true` to see
 * everything, e.g. for an admin view that lists past terms too.
 *
 * `db` accepts `Executor`, not just `Database`: `actions/projects.ts#duplicateProjectAction`
 * (finding 1 of the PROJ-4/5/TEN-7/8 rework) calls this from inside its own
 * transaction, to find the row a name collision refused.
 */
export function listProjects(
  organizationId: string,
  db: Executor,
  options?: { includeArchived?: boolean }
): Project[] {
  // DATA-9 — a soft-deleted project never appears in a list, archived or
  // not.
  const conditions = [
    eq(projects.organizationId, organizationId),
    isNull(projects.deletedAt),
  ]
  if (!options?.includeArchived) {
    conditions.push(isNull(projects.archivedAt))
  }
  return db
    .select()
    .from(projects)
    .where(and(...conditions))
    .all()
}

/**
 * Rename a project.
 *
 * `undefined` when `projectId` does not exist or does not belong to
 * `organizationId` (TEN-2), the same refusal shape `updateCourse`
 * (`repos/courses.ts`) uses. Refused, naming the conflict, rather than
 * letting `projects_org_name_active_unique` (`schema.ts`) throw when `name`
 * is already used by another active project in this organization — the
 * partial unique index only applies to non-archived rows, so renaming an
 * *archived* project never collides, whatever `name` is.
 */
export function renameProject(
  organizationId: string,
  projectId: string,
  name: string,
  db: Database
): SaveProjectResult | undefined {
  const existing = db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        // DATA-9 — a soft-deleted project cannot be renamed.
        isNull(projects.deletedAt)
      )
    )
    .get()
  if (!existing) return undefined

  try {
    const updated = db
      .update(projects)
      .set({ name })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .returning()
      .get()
    // `existing` already proved the row is there; `updated` can only be
    // missing here if a concurrent write removed it between the two
    // queries, which nothing in this package does. Fall back to `existing`
    // rather than asserting, so a future concurrent caller cannot turn this
    // into a thrown error either.
    return { ok: true, project: updated ?? existing }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    // The database just refused this exact write for this exact reason, so
    // the conflicting row is there to find — the fallback message covers
    // only the race where it was renamed or archived between the failed
    // write and this lookup.
    const conflict = findActiveProjectConflict(
      organizationId,
      name,
      db,
      projectId
    ) ?? {
      name,
      conflictingProjectId: '',
      message: `Project name "${name}" is already used by another active project in this organization.`,
    }
    return { ok: false, conflict }
  }
}

/**
 * Archive a project (PROJ-2).
 *
 * Deletes nothing: its courses, categories and channels remain in the
 * database and stay readable, they simply stop routing (PROJ-3 excludes a
 * course in an archived project from the name-collision check). The
 * `archivedAt IS NULL` condition makes archiving an already-archived
 * project a no-op — `0` rows changed — rather than resetting its archive
 * timestamp.
 */
export function archiveProject(
  organizationId: string,
  projectId: string,
  db: Database
): number {
  const result = db
    .update(projects)
    .set({ archivedAt: Date.now() })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt)
      )
    )
    .run()
  return result.changes
}

/**
 * Unarchive a project (PROJ-2) — reverses `archiveProject`.
 *
 * `undefined` when `projectId` does not exist or does not belong to
 * `organizationId` (TEN-2). A project that is not currently archived is
 * left untouched and reported as an idempotent success (`{ ok: true,
 * project: existing }`), matching `archiveProject`'s no-op treatment of the
 * reverse case rather than treating "already in the state you asked for" as
 * an error.
 *
 * Refused, naming the conflict, in two cases neither backed by a thrown
 * driver error reaching the caller:
 *  - the project's own name is now used by another active project (the
 *    partial unique index excludes archived rows, so this can only be
 *    discovered here, not on `archiveProject`, which is why a name is free
 *    to reuse while a project is archived in the first place);
 *  - unarchiving would put an enabled course of this project back in
 *    PROJ-3's candidate set with a name another course took while this
 *    project was archived (`findProjectUnarchiveConflict`,
 *    `repos/courses.ts`) — the same hole `enableCourse` closes for a single
 *    course, one level up, for every course a project brings back at once.
 */
export function unarchiveProject(
  organizationId: string,
  projectId: string,
  db: Database
): UnarchiveProjectResult | undefined {
  const existing = db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        // DATA-9 — a soft-deleted project cannot be unarchived.
        isNull(projects.deletedAt)
      )
    )
    .get()
  if (!existing) return undefined
  if (existing.archivedAt === null) return { ok: true, project: existing }

  const courseConflict = findProjectUnarchiveConflict(
    organizationId,
    projectId,
    db
  )
  if (courseConflict) return { ok: false, conflict: courseConflict }

  try {
    const updated = db
      .update(projects)
      .set({ archivedAt: null })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNotNull(projects.archivedAt)
        )
      )
      .returning()
      .get()
    // `updated` is missing only if a concurrent write already unarchived
    // (or removed) the row between the read above and this write — treat
    // that as the idempotent success it already is, rather than asserting.
    return { ok: true, project: updated ?? { ...existing, archivedAt: null } }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    const conflict = findActiveProjectConflict(
      organizationId,
      existing.name,
      db,
      projectId
    ) ?? {
      name: existing.name,
      conflictingProjectId: '',
      message: `Project name "${existing.name}" is already used by another active project in this organization.`,
    }
    return { ok: false, conflict }
  }
}

/**
 * DATA-7 — soft-delete a project: stamp `deletedAt`/`deletedByAccountId` on
 * the project itself and, with the *same* timestamp, on every `courses` row
 * it owns (`schema.ts`'s own `courses.projectId`) — the same
 * "same timestamp is what a restore reads" cascade
 * `organizations.ts#softDeleteOrganization` already holds itself to, one
 * level down. A course's own conversations are cascaded transitively by
 * `courses.ts#softDeleteCourse` for a *single*-course delete — this function
 * does not repeat that work per course, since a project delete removes
 * conversations the same way, filtered only by `courseId IN (this
 * project's courses)` rather than by `courses.deletedAt`, which the
 * following statement sets in the same transaction.
 *
 * `undefined` when `projectId` does not exist, or does not belong to
 * `organizationId` (TEN-2), or is already deleted. An *archived* project is
 * deleted exactly as readily as a live one — nothing here reads
 * `archivedAt`, the same "archiving and deleting never merge" reasoning
 * `deletions.ts#deleteProject`'s own doc comment already gives.
 */
export function softDeleteProject(
  organizationId: string,
  projectId: string,
  deletedByAccountId: string,
  db: Database
): Project | undefined {
  return writeTransaction(db, (tx) => {
    const now = Date.now()
    const project = tx
      .update(projects)
      .set({ deletedAt: now, deletedByAccountId })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt)
        )
      )
      .returning()
      .get()
    if (!project) return undefined

    // Only the project's currently-*live* courses cascade — one already
    // soft-deleted on its own keeps its own, earlier timestamp (this
    // function's own doc comment).
    const courseIds = tx
      .select({ id: courses.id })
      .from(courses)
      .where(
        and(
          eq(courses.organizationId, organizationId),
          eq(courses.projectId, projectId),
          isNull(courses.deletedAt)
        )
      )
      .all()
      .map((row) => row.id)

    tx.update(courses)
      .set({ deletedAt: now, deletedByAccountId })
      .where(
        and(
          eq(courses.organizationId, organizationId),
          eq(courses.projectId, projectId),
          isNull(courses.deletedAt)
        )
      )
      .run()

    if (courseIds.length > 0) {
      tx.update(conversations)
        .set({ deletedAt: now, deletedByAccountId })
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            inArray(conversations.courseId, courseIds),
            isNull(conversations.deletedAt)
          )
        )
        .run()
    }

    return project
  })
}

/**
 * DATA-7 — restore a soft-deleted project: read its own `deletedAt` first
 * (unfiltered — the DATA-9 convention test's own named "a restore"
 * exception, the same reason `organizations.ts#restoreOrganization` needs
 * it), then un-mark every `courses`/`conversations` row that carries that
 * *same* timestamp — never a course (or its conversations) deleted
 * independently, before or after this project's own delete.
 *
 * `undefined` when `projectId` does not exist, or does not belong to
 * `organizationId` (TEN-2), or is not currently deleted.
 */
export function restoreProject(
  organizationId: string,
  projectId: string,
  db: Database
): Project | undefined {
  return writeTransaction(db, (tx) => {
    const existing = tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId)
        )
      )
      .get()
    if (!existing || existing.deletedAt === null) return undefined
    const deletedAt = existing.deletedAt

    const courseIds = tx
      .select({ id: courses.id })
      .from(courses)
      .where(
        and(
          eq(courses.organizationId, organizationId),
          eq(courses.projectId, projectId),
          eq(courses.deletedAt, deletedAt)
        )
      )
      .all()
      .map((row) => row.id)

    tx.update(courses)
      .set({ deletedAt: null, deletedByAccountId: null })
      .where(
        and(
          eq(courses.organizationId, organizationId),
          eq(courses.projectId, projectId),
          eq(courses.deletedAt, deletedAt)
        )
      )
      .run()

    if (courseIds.length > 0) {
      tx.update(conversations)
        .set({ deletedAt: null, deletedByAccountId: null })
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            inArray(conversations.courseId, courseIds),
            eq(conversations.deletedAt, deletedAt)
          )
        )
        .run()
    }

    return tx
      .update(projects)
      .set({ deletedAt: null, deletedByAccountId: null })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.organizationId, organizationId),
          eq(projects.deletedAt, deletedAt)
        )
      )
      .returning()
      .get()
  })
}

/**
 * DATA-8 — every project whose `deletedAt` is at or before `cutoff`, across
 * every organization: the retention sweep's own candidate list for
 * `deletions.deleteProject`. Unscoped by `organizationId` — the same
 * "the sweep is platform-wide" TEN-2/DATA-9 exception
 * `organizations.ts#listOrganizationsDeletedBefore` already is, one level
 * down.
 */
export function listProjectsDeletedBefore(
  cutoff: number,
  db: Database
): Project[] {
  return db
    .select()
    .from(projects)
    .where(and(isNotNull(projects.deletedAt), lte(projects.deletedAt, cutoff)))
    .all()
}
