/**
 * Actions over `packages/db`'s `courses` repo (PROJ-1, PROJ-3, PROJ-5),
 * proving the action shape against a real repository — `courses.save`
 * (create or update, through the same collision handling `packages/db`
 * already runs), `courses.enable`, `courses.disable`, and PROJ-5's own
 * reads: `courses.list` and `courses.get`.
 */

import { courses, projects, schema, type Database } from '@bloombot/db'
import { z } from 'zod'

import { ActionConflictError, ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Project = NonNullable<ReturnType<typeof projects.getProject>>
type Course = NonNullable<ReturnType<typeof courses.getCourse>>

const listCoursesInputSchema = z.object({
  projectId: z.string().min(1),
})
type ListCoursesInput = z.infer<typeof listCoursesInputSchema>

/**
 * PROJ-5: list a project's courses. Resolves the project itself, scoped to
 * the caller's organization (ACT-2) — the same "not an existing record to
 * write, but still a real tenant-scoped lookup" shape `projects.create`'s
 * policy uses, one level down. Base rows only (no categories or channels) —
 * matching `listCourses`'s (`repos/courses.ts`) own split from `getCourse`,
 * below.
 */
export const listCoursesAction: Action<
  'courses.list',
  ListCoursesInput,
  Project,
  courses.Course[]
> = {
  name: 'courses.list',
  description:
    "List a project's courses (base rows only — use courses.get for one course's categories and channels).",
  inputSchema: listCoursesInputSchema,
  policy: {
    descriptor: { resource: 'project', access: 'read' },
    resolve: (input, context) =>
      projects.getProject(context.organizationId, input.projectId, context.db),
  },
  execute: ({ organizationId, entity, db }) =>
    courses.listCourses(organizationId, db, { projectId: entity.id }),
}

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
 * `courses.save` which of `packages/db`'s two functions to call. Unlike
 * `NewCourse`'s own doc comment ("only used on create") one level up,
 * `courses.save` never actually accepts a caller-supplied id on create —
 * the policy (below) refuses the whole call whenever `input.id` does not
 * already resolve to an existing course in this organization, so by the
 * time `execute` runs, `input.id` present always means
 * `entity.existingCourse` is set.
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
    // Finding 2 (rework pass): `promptId`, `model`, `vectorStoreId` and
    // `maxRequestsPerDay` are optional in `saveInputSchema` so a caller can
    // update, say, only a course's title — but that means an *omitted*
    // field must keep whatever is already stored, not get wiped to `null`.
    // An *explicit* `null` is the caller's way to clear one, and
    // `exactOptionalPropertyTypes` is exactly what makes "omitted"
    // (`undefined`) and "explicitly cleared" (`null`) two different values
    // `input.promptId` etc. can actually carry, rather than both collapsing
    // to the same thing. On create there is nothing yet to preserve, so an
    // omitted field there falls back to `null`, matching `createCourse`'s
    // own previous behaviour. `instructions` is deliberately not part of
    // this list any more — see this action's own `instructions:` line
    // below.
    const keepOrClear = <Value>(
      given: Value | null | undefined,
      stored: Value | null | undefined
    ): Value | null => (given !== undefined ? given : (stored ?? null))

    const newCourse: courses.NewCourse = {
      // `id` is never supplied here — `entity.existingCourse` set is the
      // only case that reaches `updateCourse`, which does not read `id`
      // off `NewCourse` at all; `createCourse` generates its own.
      projectId: entity.project.id,
      title: input.title,
      filePrefix: input.filePrefix,
      enabled: input.enabled,
      adminsRole: input.adminsRole,
      studentsRole: input.studentsRole,
      // MDL-8 — a stored prompt id is only ever inherited from the Python
      // era (D-3's escape hatch), never newly acquired: a course being
      // *created* here (`entity.existingCourse` unset) gets `null`
      // regardless of what `input.promptId` carries, even an explicit
      // value — `keepOrClear` is only reached on update, where an existing
      // `promptId` may still be kept or explicitly cleared. The panel
      // itself already stopped offering the field at all
      // (`pages/CourseEditor.tsx`); this is the same refusal enforced
      // where a caller cannot route around the panel's own choice not to
      // ask.
      promptId: entity.existingCourse
        ? keepOrClear(input.promptId, entity.existingCourse.promptId)
        : null,
      // WEB-19/D-54: `instructions` is never read off `input` at all — it
      // has no key in `saveInputSchema` any more (below the schema's own
      // comment for why) — so this always carries forward whatever a
      // course already has, unchanged, and `null` for a course being
      // created. The only way to actually change it is
      // `courseInstructions.save` (FILE-4), which is what stamps an author
      // and a time onto the change; this action writing the same column
      // straight from a caller's input, unversioned, is exactly the gap
      // WEB-19 closed.
      instructions: entity.existingCourse?.instructions ?? null,
      model: keepOrClear(input.model, entity.existingCourse?.model),
      vectorStoreId: keepOrClear(
        input.vectorStoreId,
        entity.existingCourse?.vectorStoreId
      ),
      maxRequestsPerDay: keepOrClear(
        input.maxRequestsPerDay,
        entity.existingCourse?.maxRequestsPerDay
      ),
      // `conversationScope` has no "clear" state to distinguish — it is not
      // nullable (`schema.ts`'s own column default is `'course'`) — so
      // omitted means "keep what is stored" on update, or "let
      // `createCourse` apply its default" on create; never written as
      // `undefined` explicitly (`exactOptionalPropertyTypes` again).
      ...(input.conversationScope
        ? { conversationScope: input.conversationScope }
        : entity.existingCourse
          ? { conversationScope: entity.existingCourse.conversationScope }
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

/**
 * PROJ-5: open one course, with its categories and channels. `resolveOwnCourse`
 * (above) already returns exactly `getCourse`'s own shape, so this action's
 * `execute` hands back the entity the policy resolved rather than looking it
 * up a second time.
 */
export const getCourseAction: Action<
  'courses.get',
  CourseIdInput,
  Course,
  Course
> = {
  name: 'courses.get',
  description: 'Open one course, with its categories and channels.',
  inputSchema: courseIdInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'read' },
    resolve: resolveOwnCourse,
  },
  execute: ({ entity }) => entity,
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
    // Finding 4 (rework pass): `result.changed` is rows-changed, not
    // state — enabling an already-enabled course is `enableCourse`'s own
    // idempotent no-op (`{ ok: true, changed: false }`, `repos/courses.ts`),
    // and the course is enabled either way once `result.ok` is true.
    // Reporting `changed` here told a caller enabling an already-enabled
    // course "this failed," which is not true.
    return { enabled: true }
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
  execute: ({ organizationId, entity, db }) => {
    // Finding 4 (rework pass): same fix as `courses.enable`, above —
    // `disableCourse` returns rows-changed, not state, and disabling an
    // already-disabled course changes `0` rows without failing. There is no
    // conflict case here (removing a course from PROJ-3's candidate set
    // cannot collide with anything), so the course is disabled either way
    // once this returns; report that state, not the row count.
    courses.disableCourse(organizationId, entity.id, db)
    return { disabled: true }
  },
}
