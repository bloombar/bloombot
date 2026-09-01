/**
 * Repository for `projects` (PROJ-1, PROJ-2).
 *
 * A project groups a set of courses, typically a term. Every function here
 * is scoped by `organizationId`, its first parameter — there is no
 * exception in this file (TEN-2).
 */

import { and, eq, isNull, isNotNull } from 'drizzle-orm'

import type { Database } from '../client.js'
import { projects } from '../schema.js'

export type Project = typeof projects.$inferSelect

/** Fields the caller supplies when creating a project. */
export interface NewProject {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  name: string
}

/**
 * Create a project.
 *
 * A project name must be unique within an organization among its
 * non-archived projects — enforced by `projects_org_name_active_unique`
 * (`schema.ts`), a partial unique index, so a colliding insert fails at the
 * database level rather than on an application check this function would
 * otherwise have to remember to run.
 */
export function createProject(
  organizationId: string,
  input: NewProject,
  db: Database
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
 */
export function listProjects(
  organizationId: string,
  db: Database,
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
 * Returns the number of rows changed — `0` rather than a different
 * organization's project when `organizationId` does not match.
 */
export function renameProject(
  organizationId: string,
  projectId: string,
  name: string,
  db: Database
): number {
  const result = db
    .update(projects)
    .set({ name })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId)
      )
    )
    .run()
  return result.changes
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
 * Unarchive a project (PROJ-2) — reverses `archiveProject`. A project that
 * is not currently archived is left untouched: `0` rows changed.
 */
export function unarchiveProject(
  organizationId: string,
  projectId: string,
  db: Database
): number {
  const result = db
    .update(projects)
    .set({ archivedAt: null })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNotNull(projects.archivedAt)
      )
    )
    .run()
  return result.changes
}
