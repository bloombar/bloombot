/**
 * Actions over `packages/db`'s `courses` repo (PROJ-1, PROJ-3), proving the
 * action shape against a real repository — `courses.save` (create or
 * update, through the same collision handling `packages/db` already runs),
 * `courses.enable`, `courses.disable`.
 */

import { courses, projects, schema, type Database } from '@bloombot/db'
import { z } from 'zod'

import { ActionConflictError, ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Project = NonNullable<ReturnType<typeof projects.getProject>>
type Course = NonNullable<ReturnType<typeof courses.getCourse>>

const channelInputSchema = z.object({
  name: z.string().min(1),
  adminsOnly: z.boolean(),
})
const categoryInputSchema = z.object({
  name: z.string().min(1),
  channels: z.array(channelInputSchema),
})

/**
 * `id` is only meaningful when saving an *update*: its presence, not a
 * separate `courses.create`/`courses.update` pair of actions, is what tells
 * `courses.save` which of `packages/db`'s two functions to call — matching
 * `NewCourse`'s own doc comment ("only used on create") one level up, since
 * a create still accepts a caller-supplied id.
 */
const saveInputSchema = z.object({
  id: z.string().min(1).optional(),
  projectId: z.string().min(1),
  title: z.string().min(1),
  filePrefix: z.string().min(1),
  enabled: z.boolean(),
  adminsRole: z.string().min(1),
  studentsRole: z.string().min(1),
  promptId: z.string().min(1).nullable().optional(),
  instructions: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  vectorStoreId: z.string().min(1).nullable().optional(),
  maxRequestsPerDay: z.number().int().positive().nullable().optional(),
  conversationScope: z.enum(schema.CONVERSATION_SCOPES).optional(),
  categories: z.array(categoryInputSchema),
})
type SaveInput = z.infer<typeof saveInputSchema>

/**
 * What `courses.save`'s policy resolves: the project the course is (or will
 * be) saved into, always, plus the course itself when `input.id` names one
 * to update. Both are looked up scoped to the caller's organization
 * (ACT-2) — an `input.projectId` or `input.id` belonging to another
 * organization resolves to `undefined` for either half, refusing the whole
 * call before `execute` ever runs.
 */
interface CourseSaveEntity {
  project: Project
  existingCourse?: Course
}

export const saveCourseAction: Action<
  'courses.save',
  SaveInput,
  CourseSaveEntity,
  Course
> = {
  name: 'courses.save',
  description:
    "Create or update a course in the caller's organization, replacing its categories and channels.",
  inputSchema: saveInputSchema,
  policy: {
    descriptor: { resource: 'project', access: 'write' },
    resolve: (input, context) => {
      const project = projects.getProject(
        context.organizationId,
        input.projectId,
        context.db
      )
      if (!project) return undefined
      if (!input.id) return { project }

      const existingCourse = courses.getCourse(
        context.organizationId,
        input.id,
        context.db
      )
      if (!existingCourse) return undefined
      return { project, existingCourse }
    },
  },
  execute: ({ organizationId, input, entity, db }) => {
    // `entity.project.id`, not `input.projectId` — the policy already
    // resolved and checked it (ACT-2). `id` is only ever supplied to
    // `NewCourse` on create (its own doc comment, `repos/courses.ts`) —
    // `exactOptionalPropertyTypes` means the property has to be omitted
    // entirely rather than set to `undefined` when there is none to give it.
    const newCourse: courses.NewCourse = {
      ...(entity.existingCourse ? {} : input.id ? { id: input.id } : {}),
      projectId: entity.project.id,
      title: input.title,
      filePrefix: input.filePrefix,
      enabled: input.enabled,
      adminsRole: input.adminsRole,
      studentsRole: input.studentsRole,
      promptId: input.promptId ?? null,
      instructions: input.instructions ?? null,
      model: input.model ?? null,
      vectorStoreId: input.vectorStoreId ?? null,
      maxRequestsPerDay: input.maxRequestsPerDay ?? null,
      // Same `exactOptionalPropertyTypes` reasoning as `id` above — omitted
      // entirely rather than set to `undefined` when the caller left it out.
      ...(input.conversationScope
        ? { conversationScope: input.conversationScope }
        : {}),
      categories: input.categories,
    }

    const result = entity.existingCourse
      ? courses.updateCourse(
          organizationId,
          entity.existingCourse.id,
          newCourse,
          db
        )
      : courses.createCourse(organizationId, newCourse, db)

    // `updateCourse` returns `undefined` only on the same TEN-2 race
    // `unarchiveProject` guards against in `actions/projects.ts` — the
    // policy already proved the course existed and belonged to this
    // organization moments earlier.
    if (!result) throw new ActionRefusedError()
    // PROJ-3's own collision, named — see `docs/DECISIONS.md`.
    if (!result.ok) throw new ActionConflictError(result.conflict)
    return result.course
  },
}

const courseIdInputSchema = z.object({
  courseId: z.string().min(1),
})
type CourseIdInput = z.infer<typeof courseIdInputSchema>

/** Both `courses.enable` and `courses.disable` resolve the same way: the course named by `input.courseId`, scoped to the caller's organization (ACT-2). */
function resolveOwnCourse(
  input: CourseIdInput,
  context: { organizationId: string; db: Database }
): Course | undefined {
  return courses.getCourse(context.organizationId, input.courseId, context.db)
}

export const enableCourseAction: Action<
  'courses.enable',
  CourseIdInput,
  Course,
  { enabled: boolean }
> = {
  name: 'courses.enable',
  description:
    'Enable a disabled course, re-running the PROJ-3 collision check every enable does.',
  inputSchema: courseIdInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: resolveOwnCourse,
  },
  execute: ({ organizationId, entity, db }) => {
    const result = courses.enableCourse(organizationId, entity.id, db)
    if (!result) throw new ActionRefusedError()
    if (!result.ok) throw new ActionConflictError(result.conflict)
    return { enabled: result.changed }
  },
}

export const disableCourseAction: Action<
  'courses.disable',
  CourseIdInput,
  Course,
  { disabled: boolean }
> = {
  name: 'courses.disable',
  description:
    "Disable a course, PROJ-3's other escape hatch alongside archiving its project.",
  inputSchema: courseIdInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: resolveOwnCourse,
  },
  execute: ({ organizationId, entity, db }) => ({
    disabled: courses.disableCourse(organizationId, entity.id, db) > 0,
  }),
}
