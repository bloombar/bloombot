/**
 * Actions over `packages/db`'s `courses` repo (PROJ-1, PROJ-3, PROJ-5),
 * proving the action shape against a real repository — `courses.save`
 * (create or update, through the same collision handling `packages/db`
 * already runs), `courses.updateSettings` (ACT-7 — the same settings,
 * without replacing categories and channels), `courses.enable`,
 * `courses.disable`, and PROJ-5's own reads: `courses.list` and
 * `courses.get`.
 */

import {
  courses,
  discordServers,
  projects,
  schema,
  type Database,
} from '@bloombot/db'
import { z } from 'zod'

import { ActionConflictError, ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Project = NonNullable<ReturnType<typeof projects.getProject>>
type Course = NonNullable<ReturnType<typeof courses.getCourse>>

// Finding 2 (rework pass): an *omitted* optional field on update must keep
// whatever is already stored, not get wiped to `null` — an *explicit* `null`
// is the caller's way to clear one. `exactOptionalPropertyTypes` is what
// makes "omitted" (`undefined`) and "explicitly cleared" (`null`) two
// different values a field can carry, rather than both collapsing to the
// same thing. Module scope, not local to `courses.save`'s own `execute`
// (where this used to live): `courses.updateSettings` (ACT-7) needs the same
// rule for every nullable field it accepts, and a second copy of this would
// be exactly the kind of duplicated logic that drifts the moment one copy is
// fixed and the other is not.
function keepOrClear<Value>(
  given: Value | null | undefined,
  stored: Value | null | undefined
): Value | null {
  return given !== undefined ? given : (stored ?? null)
}

/**
 * TEN-9/TEN-5 — `true` when `discordServerId` is either not supplied at all
 * (nothing to check) or names a server actively bound to `organizationId`.
 * Shared by `courses.save` and `courses.updateSettings`'s policies, both of
 * which refuse the whole call the same "not found" way TEN-5 refuses a
 * foreign `projectId` when this is `false` — never a distinct error a caller
 * could use to probe whether some other organization holds that server.
 */
function isOwnDiscordServerOrAbsent(
  organizationId: string,
  discordServerId: string | null | undefined,
  db: Database
): boolean {
  if (!discordServerId) return true
  return Boolean(
    discordServers.getActiveDiscordServerBinding(
      organizationId,
      discordServerId,
      db
    )
  )
}

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
 *
 * `z.strictObject`, not `z.object` (WEB-19/D-54 rework): a plain `z.object`
 * silently strips a key it does not recognize rather than refusing it, so
 * `instructions` — deliberately not declared below, now that
 * `courseInstructions.save` is the only versioned way to change it — would
 * otherwise still round-trip through this action's own `dispatch` with no
 * error at all: a caller (an MCP agent told to "update the course
 * instructions," a stale client, a script) gets back an ordinary successful
 * course, sees no refusal, and the instructions never actually changed. The
 * MCP tool surface already advertises `additionalProperties: false`
 * (`apps/mcp/src/tool-surface.ts`'s own `z.toJSONSchema`), which only
 * protects a caller that validates against it — `z.strictObject` is what
 * makes the *server* refuse the same thing outright
 * (`action_input_invalid`), the same "the panel not offering a field is not
 * itself enforcement" reasoning D-53/D-54 already apply to this action's
 * `execute`, extended to its schema.
 */
const saveInputSchema = z.strictObject({
  id: z.string().min(1).optional(),
  projectId: z.string().min(1),
  title: z.string().min(1),
  enabled: z.boolean(),
  // PROJ-7 — optional and nullable, like `model` below: a course may name
  // no role at all, meaning the platform does not attempt role-based
  // identification for it. `.min(1)` still refuses an *empty string*
  // outright — an instructor clearing the field must send an explicit
  // `null`, never `''`, the same "absent, not empty" distinction
  // `schema.ts`'s own column carries; `execute`, below, writes whichever of
  // the two a caller actually sent, never `''` itself.
  adminsRole: z.string().min(1).nullable().optional(),
  studentsRole: z.string().min(1).nullable().optional(),
  promptId: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  vectorStoreId: z.string().min(1).nullable().optional(),
  maxRequestsPerDay: z.number().int().positive().nullable().optional(),
  conversationScope: z.enum(schema.CONVERSATION_SCOPES).optional(),
  // ENRL-13/ENRL-14 — the same "no clear state, omitted keeps whatever is
  // stored" treatment `conversationScope` above already gets: neither is
  // nullable (`schema.ts`'s own column defaults are `false`/`true`), so
  // there is nothing for an explicit `null` to mean.
  selfEnrolFromDiscord: z.boolean().optional(),
  answerUnenrolled: z.boolean().optional(),
  // TEN-9 — which of the organization's Discord servers this course routes
  // in. Validated below, in the policy, as an *actively bound* server of the
  // caller's own organization — a caller naming another organization's
  // server, or a removed binding, is refused the same "not found" way TEN-5
  // refuses `projectId`/`id`, not told the binding exists elsewhere.
  discordServerId: z.string().min(1).nullable().optional(),
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
    "Create or update a course in the caller's organization, replacing its categories and channels. Changing only a setting (title, roles, model, etc.) on an existing course? Use courses.updateSettings instead — this always replaces the whole category/channel list, even when the caller never touched it.",
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

      // TEN-9/TEN-5 — `isOwnDiscordServerOrAbsent` (module scope, above),
      // shared with `courses.updateSettings`'s own policy below.
      if (
        !isOwnDiscordServerOrAbsent(
          context.organizationId,
          input.discordServerId,
          context.db
        )
      ) {
        return undefined
      }

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
    // below. `keepOrClear` itself is module scope now (above) — shared with
    // `courses.updateSettings`.
    const newCourse: courses.NewCourse = {
      // `id` is never supplied here — `entity.existingCourse` set is the
      // only case that reaches `updateCourse`, which does not read `id`
      // off `NewCourse` at all; `createCourse` generates its own.
      projectId: entity.project.id,
      title: input.title,
      enabled: input.enabled,
      // PROJ-7 — the same omitted-preserves/explicit-null-clears rule
      // `keepOrClear` already gives `promptId`/`model`/etc. below: an
      // omitted key on update keeps whatever role is already stored, an
      // explicit `null` clears it (an instructor blanking the field —
      // `pages/CourseEditor.tsx` never sends `''`, see that form's own
      // comment), and a create with the key omitted gets `null`, the same
      // "nothing yet to preserve" default every other optional field here
      // gets.
      adminsRole: keepOrClear(
        input.adminsRole,
        entity.existingCourse?.adminsRole
      ),
      studentsRole: keepOrClear(
        input.studentsRole,
        entity.existingCourse?.studentsRole
      ),
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
      // has no key in `saveInputSchema` any more, and an extra one is
      // refused outright rather than silently accepted (`saveInputSchema`'s
      // own comment above, on why `z.strictObject`) — so this always
      // carries forward whatever a course already has, unchanged, and
      // `null` for a course being created. The only way to actually change
      // it is `courseInstructions.save` (FILE-4), which is what stamps an
      // author and a time onto the change; this action writing the same
      // column straight from a caller's input, unversioned, is exactly the
      // gap WEB-19 closed.
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
      // ENRL-13/ENRL-14 — the same "omitted keeps whatever is stored, or
      // lets `createCourse` apply its own default" shape `conversationScope`
      // above uses, checked against `undefined` rather than falsiness
      // (`input.selfEnrolFromDiscord ? ... : ...` would treat an explicit
      // `false` — a real, sent value — the same as "not sent at all").
      ...(input.selfEnrolFromDiscord !== undefined
        ? { selfEnrolFromDiscord: input.selfEnrolFromDiscord }
        : entity.existingCourse
          ? { selfEnrolFromDiscord: entity.existingCourse.selfEnrolFromDiscord }
          : {}),
      ...(input.answerUnenrolled !== undefined
        ? { answerUnenrolled: input.answerUnenrolled }
        : entity.existingCourse
          ? { answerUnenrolled: entity.existingCourse.answerUnenrolled }
          : {}),
      // TEN-9 — `keepOrClear`, the same as `model`/`vectorStoreId` above:
      // omitted keeps whatever is already stored (or `null` on create, since
      // there is nothing yet to keep), an explicit `null` clears it back to
      // "resolve through the organization's own single binding" — already
      // validated as an active binding of this organization, above.
      discordServerId: keepOrClear(
        input.discordServerId,
        entity.existingCourse?.discordServerId
      ),
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

/**
 * ACT-7: a partial update over an existing course's settings — every field
 * but `id` is optional, an omitted one keeps whatever is stored, and an
 * explicit `null` clears a nullable one, exactly `saveInputSchema`'s own
 * `keepOrClear` rule, reused rather than a second copy of it (module scope,
 * above). Its categories and channels are never read or written at all: the
 * only fields here overlap `saveInputSchema`'s at all are the ones
 * `courses.save` itself would keep or clear the same way — this schema has
 * no `categories` for a caller to send in the first place.
 *
 * `projectId` is deliberately absent — this never moves a course to another
 * project, unlike `courses.save`. `instructions` and `promptId` are
 * deliberately absent too, for the same reasons `saveInputSchema` (above)
 * already gives: `instructions` is `courseInstructions.save`'s job alone
 * (WEB-19/D-54), and `promptId` is MDL-8's legacy-only field, never newly
 * acquired through either action. `z.strictObject`, matching `saveInputSchema`
 * — an unknown key (`categories` included) is refused outright, not silently
 * stripped.
 */
const updateSettingsInputSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  adminsRole: z.string().min(1).nullable().optional(),
  studentsRole: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  vectorStoreId: z.string().min(1).nullable().optional(),
  maxRequestsPerDay: z.number().int().positive().nullable().optional(),
  conversationScope: z.enum(schema.CONVERSATION_SCOPES).optional(),
  selfEnrolFromDiscord: z.boolean().optional(),
  answerUnenrolled: z.boolean().optional(),
  // TEN-9 — same field, same validation, as `saveInputSchema`'s own —
  // checked in this action's policy below, reusing
  // `isOwnDiscordServerOrAbsent`.
  discordServerId: z.string().min(1).nullable().optional(),
})
type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>

export const updateSettingsCourseAction: Action<
  'courses.updateSettings',
  UpdateSettingsInput,
  Course,
  Course
> = {
  name: 'courses.updateSettings',
  description:
    "Change one or more of an existing course's settings (title, enabled, roles, model, vector store, request limit, conversation scope, self-enrolment, Discord server) in the caller's organization, leaving its categories and channels untouched. Prefer this over courses.save for any change that is not to the category/channel list — courses.save always replaces that whole list, even when the caller never touched it.",
  inputSchema: updateSettingsInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) => {
      const existingCourse = courses.getCourse(
        context.organizationId,
        input.id,
        context.db
      )
      if (!existingCourse) return undefined

      // TEN-9/TEN-5 — `isOwnDiscordServerOrAbsent` (module scope, above),
      // the same check `courses.save`'s own policy runs.
      if (
        !isOwnDiscordServerOrAbsent(
          context.organizationId,
          input.discordServerId,
          context.db
        )
      ) {
        return undefined
      }

      return existingCourse
    },
  },
  execute: ({ organizationId, input, entity, db }) => {
    // `keepOrClear` — module scope, shared with `courses.save`'s own
    // `execute` above. `title` and `enabled` have no "clear" state to
    // distinguish (neither is nullable on `updateSettingsInputSchema`), so
    // an omitted one falls straight back to what is already stored via `??`
    // rather than `keepOrClear` — there is no explicit `null` case for
    // either to carry.
    const settingsUpdate: courses.CourseSettingsUpdate = {
      title: input.title ?? entity.title,
      enabled: input.enabled ?? entity.enabled,
      adminsRole: keepOrClear(input.adminsRole, entity.adminsRole),
      studentsRole: keepOrClear(input.studentsRole, entity.studentsRole),
      model: keepOrClear(input.model, entity.model),
      vectorStoreId: keepOrClear(input.vectorStoreId, entity.vectorStoreId),
      maxRequestsPerDay: keepOrClear(
        input.maxRequestsPerDay,
        entity.maxRequestsPerDay
      ),
      conversationScope: input.conversationScope ?? entity.conversationScope,
      selfEnrolFromDiscord:
        input.selfEnrolFromDiscord ?? entity.selfEnrolFromDiscord,
      answerUnenrolled: input.answerUnenrolled ?? entity.answerUnenrolled,
      discordServerId: keepOrClear(
        input.discordServerId,
        entity.discordServerId
      ),
    }

    const result = courses.updateCourseSettings(
      organizationId,
      entity.id,
      settingsUpdate,
      db
    )
    // Same TEN-2 race `courses.save`'s own `execute` guards against, above —
    // the policy already proved the course existed and belonged to this
    // organization moments earlier.
    if (!result) throw new ActionRefusedError()
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
