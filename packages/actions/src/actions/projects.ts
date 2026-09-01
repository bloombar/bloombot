/**
 * Actions over `packages/db`'s `projects` repo (PROJ-1, PROJ-2), proving the
 * action shape against a real repository — `projects.create`,
 * `projects.archive`, `projects.unarchive`.
 */

import { organizations, projects, type Database } from '@bloombot/db'
import { z } from 'zod'

import { ActionConflictError, ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Organization = ReturnType<typeof organizations.getOrganizationById>
type Project = NonNullable<ReturnType<typeof projects.getProject>>

const createInputSchema = z.object({
  name: z.string().min(1),
})
type CreateInput = z.infer<typeof createInputSchema>

/**
 * Finding 3 (rework pass): `createProject` (`repos/projects.ts`) leaves a
 * name collision unhandled by design (D-12) — a fresh id can never have
 * collided with anything before its own insert, so the repo just lets
 * `projects_org_name_active_unique` (`schema.ts`) throw
 * `SQLITE_CONSTRAINT_UNIQUE` rather than wrap its own return type. This
 * package is exactly the layer D-12 leaves that for: every other write here
 * converts a repo-level collision into `ActionConflictError` (D-18), so a
 * duplicate project name has to as well, rather than reach the caller as an
 * unmapped 500 (`HTTP_STATUS_BY_ACTION_ERROR`, `errors.ts`, has no entry for
 * a raw driver error).
 */
function isUniqueNameConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

/**
 * `projects.create` has no existing project to resolve — the record it
 * protects is the *organization* a new project is created inside, so the
 * policy resolves that instead (still tenant-scoped: `getOrganizationById`
 * only ever returns the organization named by `organizationId` itself).
 */
export const createProjectAction: Action<
  'projects.create',
  CreateInput,
  NonNullable<Organization>,
  Project
> = {
  name: 'projects.create',
  description:
    "Create a project (a term or cohort) in the caller's organization.",
  inputSchema: createInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'write' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, db }) => {
    try {
      return projects.createProject(organizationId, { name: input.name }, db)
    } catch (error) {
      if (!isUniqueNameConstraintError(error)) throw error
      // The database just refused this exact write for this exact reason,
      // so the conflicting row is there to find — the same fallback
      // `renameProject` (`repos/projects.ts`) uses for the race where it was
      // renamed or archived between the failed write and this lookup.
      const conflictingProject = projects
        .listProjects(organizationId, db)
        .find((project) => project.name === input.name)
      // Typed as `ProjectNameConflict` (not an inline object literal passed
      // straight to `ActionConflictError`) so this matches the same shape
      // `renameProject`'s own fallback builds, rather than tripping
      // `ActionConflictError`'s excess-property check on `name` and
      // `conflictingProjectId`.
      const conflict: projects.ProjectNameConflict = {
        message: `Project name "${input.name}" is already used by another active project in this organization.`,
        name: input.name,
        conflictingProjectId: conflictingProject?.id ?? '',
      }
      throw new ActionConflictError(conflict)
    }
  },
}

const projectIdInputSchema = z.object({
  projectId: z.string().min(1),
})
type ProjectIdInput = z.infer<typeof projectIdInputSchema>

/** Both `projects.archive` and `projects.unarchive` resolve the same way: the project named by `input.projectId`, scoped to the caller's organization (ACT-2) — not a different organization's project of the same id. */
function resolveOwnProject(
  input: ProjectIdInput,
  context: { organizationId: string; db: Database }
): Project | undefined {
  return projects.getProject(
    context.organizationId,
    input.projectId,
    context.db
  )
}

export const archiveProjectAction: Action<
  'projects.archive',
  ProjectIdInput,
  Project,
  { archived: boolean }
> = {
  name: 'projects.archive',
  description:
    'Archive a project (PROJ-2), stopping its courses from routing without deleting them.',
  inputSchema: projectIdInputSchema,
  policy: {
    descriptor: { resource: 'project', access: 'write' },
    resolve: resolveOwnProject,
  },
  // `entity.id`, not `input.projectId` — the id the policy already resolved
  // and checked, not the raw one a caller supplied (ACT-2).
  execute: ({ organizationId, entity, db }) => {
    // Finding 4 (rework pass): `archiveProject`'s return is rows-changed,
    // not state — archiving an already-archived project changes `0` rows
    // (its own no-op treatment of the case, `repos/projects.ts`), not a
    // failure. There is no conflict case for archiving, so the project is
    // archived either way once this returns; report that state, not the
    // row count, matching how `projects.unarchive` (below) already reports
    // its own idempotent case honestly.
    projects.archiveProject(organizationId, entity.id, db)
    return { archived: true }
  },
}

export const unarchiveProjectAction: Action<
  'projects.unarchive',
  ProjectIdInput,
  Project,
  Project
> = {
  name: 'projects.unarchive',
  description:
    'Unarchive a project (PROJ-2), resuming routing for its enabled courses.',
  inputSchema: projectIdInputSchema,
  policy: {
    descriptor: { resource: 'project', access: 'write' },
    resolve: resolveOwnProject,
  },
  execute: ({ organizationId, entity, db }) => {
    const result = projects.unarchiveProject(organizationId, entity.id, db)
    // `undefined` only if the project vanished between `resolve` and here —
    // a race nothing in this package causes on purpose, but still refused
    // rather than thrown raw (ACT-3's same refusal, not a new error shape).
    if (!result) throw new ActionRefusedError()
    // PROJ-3/PROJ-2's own collision, named (unlike ACT-3's refusal above) —
    // see `docs/DECISIONS.md` for why that asymmetry is deliberate.
    if (!result.ok) throw new ActionConflictError(result.conflict)
    return result.project
  },
}
