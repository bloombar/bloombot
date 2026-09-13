/**
 * SRV-12: a course's Discord structure, edited one piece at a time — a
 * category added or removed, a channel added, renamed, flagged admins-only
 * or not, or removed — without restating the rest of the course. Today
 * `courses.save` (`actions/courses.ts`) is the only path, and it replaces
 * the *whole* category/channel list on every call; ACT-7's own
 * `courses.updateSettings` proved the narrower-write pattern this module
 * follows for the course's other fields, and this is that same pattern
 * applied to CFG-4's declared structure.
 *
 * Every action here resolves *upward* — a `categoryId` to its category, then
 * to the course it belongs to; a `channelId` to its channel, then its
 * category, then the course — org-scoped at every hop
 * (`packages/db/src/repos/courses.ts`'s own `getCourseCategory`/
 * `getCourseChannel`). A `categoryId`/`channelId` belonging to another
 * organization, or to no course at all, resolves to `undefined` and is
 * refused as the same undifferentiated `ActionRefusedError` every other
 * policy in this catalog refuses with (ACT-3) — never a distinct error a
 * caller could use to probe whether the id exists elsewhere.
 *
 * Nothing here touches Discord. These actions edit the declaration only —
 * SRV-6's scaffold remains the only thing that creates, renames or deletes
 * anything in a live server, and SRV-8's "scaffolding never deletes" is
 * unchanged: a channel dropped from the declaration here is reported by the
 * next scaffold, never removed from the server it already reached.
 */

import { courses } from '@bloombot/db'
import { z } from 'zod'

import { ActionConflictError, ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Course = NonNullable<ReturnType<typeof courses.getCourse>>
type ResolvedCategory = NonNullable<
  ReturnType<typeof courses.getCourseCategory>
>
type ResolvedChannel = NonNullable<ReturnType<typeof courses.getCourseChannel>>
type CourseCategory = courses.CourseCategoryWithChannels
type CourseChannel = courses.CourseChannel

const addCategoryInputSchema = z.strictObject({
  courseId: z.string().min(1),
  name: z.string().min(1),
})
type AddCategoryInput = z.infer<typeof addCategoryInputSchema>

/**
 * SRV-12: add a category to a course, after its existing categories. Refused
 * (PROJ-3) the same way `courses.save`/`courses.updateCourse` refuse a
 * category name colliding with another one already declared in this course,
 * or with another enabled course routing in the same Discord server
 * (`courses.addCourseCategory`'s own doc comment,
 * `packages/db/src/repos/courses.ts`).
 */
export const addCourseCategoryAction: Action<
  'courseChannels.addCategory',
  AddCategoryInput,
  Course,
  CourseCategory
> = {
  name: 'courseChannels.addCategory',
  description:
    "Add a category to a course's Discord structure, after its existing categories — the whole category/channel list is never touched, only the one being added.",
  inputSchema: addCategoryInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, input, entity, db }) => {
    const result = courses.addCourseCategory(
      organizationId,
      entity.id,
      input.name,
      db
    )
    // Same TEN-2 race every other `execute` in this catalog guards against
    // — the policy already proved the course existed and belonged to this
    // organization moments earlier.
    if (!result) throw new ActionRefusedError()
    if (!result.ok) throw new ActionConflictError(result.conflict)
    return result.category
  },
}

const renameCategoryInputSchema = z.strictObject({
  categoryId: z.string().min(1),
  name: z.string().min(1),
})
type RenameCategoryInput = z.infer<typeof renameCategoryInputSchema>

/**
 * SRV-12: rename a category, leaving its channels and every sibling category
 * untouched. Refused (PROJ-3) the same way `addCategory` is, above —
 * `courses.renameCourseCategory`'s own doc comment.
 */
export const renameCourseCategoryAction: Action<
  'courseChannels.renameCategory',
  RenameCategoryInput,
  ResolvedCategory,
  CourseCategory
> = {
  name: 'courseChannels.renameCategory',
  description:
    "Rename one of a course's categories, leaving its channels and every other category untouched.",
  inputSchema: renameCategoryInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourseCategory(
        context.organizationId,
        input.categoryId,
        context.db
      ),
  },
  execute: ({ organizationId, input, entity, db }) => {
    const result = courses.renameCourseCategory(
      organizationId,
      entity.category.id,
      input.name,
      db
    )
    if (!result) throw new ActionRefusedError()
    if (!result.ok) throw new ActionConflictError(result.conflict)
    return result.category
  },
}

const removeCategoryInputSchema = z.strictObject({
  categoryId: z.string().min(1),
})
type RemoveCategoryInput = z.infer<typeof removeCategoryInputSchema>

/**
 * SRV-12: remove a category and every channel declared inside it —
 * `removedChannelCount` says how many went with it, so a caller that meant
 * to remove one channel must not discover it removed six (this action's own
 * `apps/mcp` entry marks it destructive and describes exactly this before it
 * runs). Nothing here reaches Discord — this module's own comment above.
 */
export const removeCourseCategoryAction: Action<
  'courseChannels.removeCategory',
  RemoveCategoryInput,
  ResolvedCategory,
  { removed: boolean; removedChannelCount: number }
> = {
  name: 'courseChannels.removeCategory',
  description:
    "Remove one of a course's categories and every channel declared inside it, reporting how many channels went with it. Never removes anything from a live Discord server — only the declaration.",
  inputSchema: removeCategoryInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourseCategory(
        context.organizationId,
        input.categoryId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, db }) => {
    const result = courses.removeCourseCategory(
      organizationId,
      entity.category.id,
      db
    )
    if (!result) throw new ActionRefusedError()
    return { removed: true, removedChannelCount: result.removedChannelCount }
  },
}

const addChannelInputSchema = z.strictObject({
  categoryId: z.string().min(1),
  name: z.string().min(1),
  adminsOnly: z.boolean(),
})
type AddChannelInput = z.infer<typeof addChannelInputSchema>

/**
 * SRV-12: add a channel to a category, after its existing channels. No
 * PROJ-3 check — channel names carry no uniqueness invariant `courses.save`
 * itself enforces (`courses.addCourseChannel`'s own doc comment,
 * `packages/db/src/repos/courses.ts`).
 */
export const addCourseChannelAction: Action<
  'courseChannels.addChannel',
  AddChannelInput,
  ResolvedCategory,
  CourseChannel
> = {
  name: 'courseChannels.addChannel',
  description:
    "Add a channel to one of a course's categories, after its existing channels — the whole category/channel list is never touched, only the one being added.",
  inputSchema: addChannelInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourseCategory(
        context.organizationId,
        input.categoryId,
        context.db
      ),
  },
  execute: ({ organizationId, input, entity, db }) => {
    const channel = courses.addCourseChannel(
      organizationId,
      entity.category.id,
      { name: input.name, adminsOnly: input.adminsOnly },
      db
    )
    if (!channel) throw new ActionRefusedError()
    return channel
  },
}

/**
 * `z.strictObject`, matching every other action in this catalog: an unknown
 * key is refused outright, not silently stripped (`courses.ts`'s own
 * `saveInputSchema` doc comment has the fuller reasoning). Neither `name`
 * nor `adminsOnly` is nullable — an omitted key keeps whatever is already
 * stored (`courses.updateCourseChannel`'s own `CourseChannelUpdate`, ACT-7's
 * same rule) — so an explicit `null` means nothing here and is refused by
 * this schema rather than silently accepted as "clear the field," which
 * neither field has a state for.
 */
const updateChannelInputSchema = z.strictObject({
  channelId: z.string().min(1),
  name: z.string().min(1).optional(),
  adminsOnly: z.boolean().optional(),
})
type UpdateChannelInput = z.infer<typeof updateChannelInputSchema>

/**
 * SRV-12: change a channel's name and/or its admins-only flag, leaving
 * everything else about it — and every other category or channel in the
 * course — untouched. An omitted field keeps whatever is already stored,
 * the same rule `courses.updateSettings` (ACT-7) already applies to the
 * course's own settings.
 */
export const updateCourseChannelAction: Action<
  'courseChannels.updateChannel',
  UpdateChannelInput,
  ResolvedChannel,
  CourseChannel
> = {
  name: 'courseChannels.updateChannel',
  description:
    "Change a channel's name and/or its admins-only flag, leaving everything else about the course untouched. An omitted field keeps whatever is already stored.",
  inputSchema: updateChannelInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourseChannel(
        context.organizationId,
        input.channelId,
        context.db
      ),
  },
  execute: ({ organizationId, input, entity, db }) => {
    // Only the keys the caller actually sent, never `undefined` explicitly
    // (`exactOptionalPropertyTypes` — `courses.ts`'s own `keepOrClear`
    // comment has the fuller reasoning for why this distinction matters).
    const update: courses.CourseChannelUpdate = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.adminsOnly !== undefined
        ? { adminsOnly: input.adminsOnly }
        : {}),
    }
    const channel = courses.updateCourseChannel(
      organizationId,
      entity.channel.id,
      update,
      db
    )
    if (!channel) throw new ActionRefusedError()
    return channel
  },
}

const removeChannelInputSchema = z.strictObject({
  channelId: z.string().min(1),
})
type RemoveChannelInput = z.infer<typeof removeChannelInputSchema>

/**
 * SRV-12: remove a single channel, leaving its category and every sibling
 * channel untouched. Nothing here reaches Discord — this module's own
 * comment above.
 */
export const removeCourseChannelAction: Action<
  'courseChannels.removeChannel',
  RemoveChannelInput,
  ResolvedChannel,
  { removed: boolean }
> = {
  name: 'courseChannels.removeChannel',
  description:
    "Remove a single channel from a course's declared structure. Never removes anything from a live Discord server — only the declaration.",
  inputSchema: removeChannelInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourseChannel(
        context.organizationId,
        input.channelId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, db }) => {
    const removed = courses.removeCourseChannel(
      organizationId,
      entity.channel.id,
      db
    )
    if (!removed) throw new ActionRefusedError()
    return { removed: true }
  },
}
