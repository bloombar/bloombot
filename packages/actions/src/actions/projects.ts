/**
 * Actions over `packages/db`'s `projects` repo (PROJ-1, PROJ-2, PROJ-4,
 * PROJ-5), proving the action shape against a real repository —
 * `projects.create`, `projects.archive`, `projects.unarchive`,
 * `projects.list` (PROJ-5's read) and `projects.duplicate` (PROJ-4).
 */

import { courses, organizations, projects, type Database } from '@bloombot/db'
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

const listInputSchema = z.object({
  // PROJ-5: "archived included on request" — defaults to excluding them,
  // matching `listProjects`'s own default (`repos/projects.ts`).
  includeArchived: z.boolean().optional(),
})
type ListInput = z.infer<typeof listInputSchema>

/**
 * PROJ-5: list the caller's own organization's projects. No existing project
 * to resolve, the same reason `projects.create`'s own policy resolves the
 * organization instead — a read is authorized the same way a write is, not
 * exempted from having a policy at all.
 */
export const listProjectsAction: Action<
  'projects.list',
  ListInput,
  NonNullable<Organization>,
  Project[]
> = {
  name: 'projects.list',
  description:
    "List the caller's organization's projects, archived ones included on request.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'read' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, db }) =>
    // `exactOptionalPropertyTypes`: only pass `includeArchived` through when
    // the caller actually supplied it, rather than `undefined` explicitly —
    // the same "omitted, not merely `undefined`" distinction `courses.save`'s
    // own `keepOrClear` (`actions/courses.ts`) is written against.
    projects.listProjects(organizationId, db, {
      ...(input.includeArchived !== undefined
        ? { includeArchived: input.includeArchived }
        : {}),
    }),
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

const duplicateInputSchema = z.object({
  projectId: z.string().min(1),
  // The new project's own name — required, not derived (e.g. "Copy of X"),
  // since `createProject` would only have to refuse a collision on a guessed
  // name anyway; asking the caller for one up front matches `projects.create`'s
  // own input.
  name: z.string().min(1),
})
type DuplicateInput = z.infer<typeof duplicateInputSchema>

/**
 * PROJ-4: copy a project into a new one, bringing its courses with their
 * categories, channels, instructions and settings — rosters and transcripts
 * are per-course/per-person tables `courses.createCourse` never touches, so
 * leaving them alone needs no special handling here, only not copying them.
 * Knowledge-file attachments do not exist yet (see `docs/DECISIONS.md`), so
 * there is nothing to copy for them either.
 *
 * PROJ-3 decision (`docs/DECISIONS.md`): every copied course is created
 * *disabled*, regardless of the source course's own `enabled` flag. A
 * duplicate's courses carry the same category and role names as their
 * originals — exactly the collision PROJ-3 forbids among enabled courses —
 * so enabling them immediately is refused the same way any other PROJ-3
 * collision would be; copying disabled instead means the duplicate can
 * never itself put the organization in a state PROJ-3 would have refused,
 * whether or not the source project is archived.
 */
export const duplicateProjectAction: Action<
  'projects.duplicate',
  DuplicateInput,
  Project,
  Project
> = {
  name: 'projects.duplicate',
  description:
    'Copy a project (PROJ-4) into a new one, bringing its courses, categories, channels, instructions and settings — disabled — and leaving rosters and transcripts untouched.',
  inputSchema: duplicateInputSchema,
  policy: {
    descriptor: { resource: 'project', access: 'write' },
    resolve: resolveOwnProject,
  },
  execute: ({ organizationId, entity, input, db }) => {
    let newProject: Project
    try {
      newProject = projects.createProject(
        organizationId,
        { name: input.name },
        db
      )
    } catch (error) {
      // The same D-12 collision `projects.create` converts, above — a
      // duplicate's own chosen name can collide with an existing project
      // exactly the way a fresh one can.
      if (!isUniqueNameConstraintError(error)) throw error
      const conflictingProject = projects
        .listProjects(organizationId, db)
        .find((project) => project.name === input.name)
      const conflict: projects.ProjectNameConflict = {
        message: `Project name "${input.name}" is already used by another active project in this organization.`,
        name: input.name,
        conflictingProjectId: conflictingProject?.id ?? '',
      }
      throw new ActionConflictError(conflict)
    }

    for (const courseRow of courses.listCourses(organizationId, db, {
      projectId: entity.id,
    })) {
      // `listCourses` returns base rows only — categories and channels come
      // from `getCourse`, the same split `repos/courses.ts`'s own comment
      // documents.
      const source = courses.getCourse(organizationId, courseRow.id, db)
      // Unreachable in practice — `courseRow` was just read from this same
      // organization moments earlier — guarded rather than assumed, the
      // same discipline every other action in this file holds itself to.
      if (!source) continue

      const result = courses.createCourse(
        organizationId,
        {
          projectId: newProject.id,
          title: source.title,
          filePrefix: source.filePrefix,
          enabled: false, // PROJ-3 decision, above.
          adminsRole: source.adminsRole,
          studentsRole: source.studentsRole,
          promptId: source.promptId,
          instructions: source.instructions,
          model: source.model,
          vectorStoreId: source.vectorStoreId,
          maxRequestsPerDay: source.maxRequestsPerDay,
          conversationScope: source.conversationScope,
          categories: source.categories.map((category) => ({
            name: category.name,
            channels: category.channels.map((channel) => ({
              name: channel.name,
              adminsOnly: channel.adminsOnly,
            })),
          })),
        },
        db
      )
      // Unreachable in practice: `enabled: false` means `createCourse` never
      // runs PROJ-3's cross-course check at all (its own guard, `input.enabled
      // && projectResult.project.archivedAt === null`), and `newProject.id`
      // was created in this organization moments earlier. Guarded rather
      // than asserted, the same discipline every other action in this file
      // holds itself to for a race nothing here causes on purpose.
      if (!result.ok) throw new ActionConflictError(result.conflict)
    }

    return newProject
  },
}
