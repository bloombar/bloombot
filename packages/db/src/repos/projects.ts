/**
 * Repository for `projects` (PROJ-1, PROJ-2).
 *
 * A project groups a set of courses, typically a term. Every function here
 * is scoped by `organizationId`, its first parameter — there is no
 * exception in this file (TEN-2).
 */

import BetterSqlite3 from 'better-sqlite3'
import { and, eq, isNull, isNotNull } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import { findProjectUnarchiveConflict } from './courses.js'
import type { CourseNameConflict } from './courses.js'
import { projects } from '../schema.js'

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
        isNull(projects.archivedAt)
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
        eq(projects.organizationId, organizationId)
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
  const conditions = [eq(projects.organizationId, organizationId)]
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
        eq(projects.organizationId, organizationId)
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
        eq(projects.organizationId, organizationId)
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
