/**
 * Repository for `courses`, `course_categories` and `course_channels`
 * (PROJ-1, PROJ-3).
 *
 * Every function here is scoped by `organizationId`, its first parameter —
 * there is no exception in this file (TEN-2).
 *
 * PROJ-3, the rule this file exists to protect: a course's category names
 * and its two role names must be unique across every *enabled* course in the
 * organization, regardless of project — a course in an archived project, or
 * a disabled course, is excluded. This cannot be a SQL constraint the way
 * `projects`' name uniqueness is (`schema.ts`): it spans three tables
 * (`courses`, `projects`, `course_categories`), depends on two other rows'
 * state (`courses.enabled`, `projects.archivedAt`), and its refusal has to
 * *name* the conflicting project and course — a `CHECK` constraint can
 * refuse a write, but it cannot explain one. So it is a repo-level check,
 * run before every create or update, following `discord-servers.ts`'s
 * pattern of reporting a routine refusal as a normal return value rather
 * than a thrown error — with one difference: a collision needs to carry
 * *what* it collided with, so the refusal here is a small result object
 * (`{ ok: false, conflict }`) rather than `undefined`.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { Database } from '../client.js'
import {
  courseCategories,
  courseChannels,
  courses,
  projects,
} from '../schema.js'

export type Course = typeof courses.$inferSelect
export type CourseCategory = typeof courseCategories.$inferSelect
export type CourseChannel = typeof courseChannels.$inferSelect

/**
 * The subset of `Database`'s query methods the transaction helpers below
 * need. `db.transaction(...)`'s own callback parameter lacks `$client` (it
 * is not a connection you can close), so it does not satisfy `Database`
 * itself — but it does satisfy this, which is all reading and writing rows
 * inside a transaction actually requires.
 */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>

/** A category with its channels attached, in declared order. */
export interface CourseCategoryWithChannels extends CourseCategory {
  channels: CourseChannel[]
}

/** A course with its categories (and their channels) attached, in order. */
export interface CourseWithCategories extends Course {
  categories: CourseCategoryWithChannels[]
}

/** A channel the caller supplies when saving a course's categories (CFG-4). */
export interface NewCourseChannel {
  name: string
  adminsOnly: boolean
}

/** A category the caller supplies when saving a course (CFG-4). */
export interface NewCourseCategory {
  name: string
  channels: NewCourseChannel[]
}

/** Fields the caller supplies when creating or updating a course. */
export interface NewCourse {
  /** Defaults to `crypto.randomUUID()` when omitted, only used on create. */
  id?: string
  projectId: string
  title: string
  filePrefix: string
  enabled: boolean
  adminsRole: string
  studentsRole: string
  promptId?: string | null
  instructions?: string | null
  model?: string | null
  vectorStoreId?: string | null
  maxRequestsPerDay?: number | null
  categories: NewCourseCategory[]
}

/** What a PROJ-3 refusal names: the field, the name, and what it collided with. */
export interface CourseNameConflict {
  field: 'category' | 'adminsRole' | 'studentsRole'
  name: string
  conflictingProjectName: string
  conflictingCourseTitle: string
  message: string
}

export type SaveCourseResult =
  | { ok: true; course: CourseWithCategories }
  | { ok: false; conflict: CourseNameConflict }

/** A candidate course (and its project) PROJ-3 checks `input` against. */
interface CollisionCandidate {
  id: string
  title: string
  adminsRole: string
  studentsRole: string
  projectName: string
}

function conflict(
  field: CourseNameConflict['field'],
  name: string,
  candidate: CollisionCandidate
): CourseNameConflict {
  const kind = field === 'category' ? 'Category' : 'Role'
  return {
    field,
    name,
    conflictingProjectName: candidate.projectName,
    conflictingCourseTitle: candidate.title,
    message:
      `${kind} name "${name}" is already used by course "${candidate.title}" ` +
      `in project "${candidate.projectName}".`,
  }
}

/**
 * PROJ-3's check. Looks across every *other* enabled course, in a
 * non-archived project, in this organization, for a category name or role
 * name `input` would collide with. `excludeCourseId` leaves the course being
 * updated out of its own candidate set — the case a naive implementation
 * misses is a course renamed into a collision that only appears because the
 * check was comparing the course against itself.
 */
function findCourseNameConflict(
  organizationId: string,
  input: Pick<NewCourse, 'adminsRole' | 'studentsRole' | 'categories'>,
  db: Database,
  excludeCourseId?: string
): CourseNameConflict | undefined {
  const candidates = db
    .select({
      id: courses.id,
      title: courses.title,
      adminsRole: courses.adminsRole,
      studentsRole: courses.studentsRole,
      projectName: projects.name,
    })
    .from(courses)
    .innerJoin(projects, eq(courses.projectId, projects.id))
    .where(
      and(
        eq(courses.organizationId, organizationId),
        eq(courses.enabled, true),
        // PROJ-2: a course in an archived project does not route, so it is
        // not a candidate for a collision.
        isNull(projects.archivedAt)
      )
    )
    .all()
    .filter((candidate) => candidate.id !== excludeCourseId)

  // Role names: `input`'s admin and student role must each be absent from
  // every candidate's admin *and* student role — a role name is one shared
  // pool, not two separate ones.
  for (const [field, roleName] of [
    ['adminsRole', input.adminsRole],
    ['studentsRole', input.studentsRole],
  ] as const) {
    const hit = candidates.find(
      (candidate) =>
        candidate.adminsRole === roleName || candidate.studentsRole === roleName
    )
    if (hit) return conflict(field, roleName, hit)
  }

  if (candidates.length === 0) return undefined

  // Category names: every candidate's own categories, looked up in one
  // query rather than one per candidate.
  const categoryRows = db
    .select({
      name: courseCategories.name,
      courseId: courseCategories.courseId,
    })
    .from(courseCategories)
    .where(
      inArray(
        courseCategories.courseId,
        candidates.map((candidate) => candidate.id)
      )
    )
    .all()
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  )

  for (const category of input.categories) {
    const hit = categoryRows.find((row) => row.name === category.name)
    if (hit) {
      // `hit.courseId` is drawn from `candidates`, so this lookup cannot miss.
      const candidate = candidatesById.get(hit.courseId)
      if (candidate) return conflict('category', category.name, candidate)
    }
  }

  return undefined
}

/**
 * Insert `categories` (and their channels) for `courseId`, preserving
 * declared order in the `ordering` column. Not exported — only called from
 * inside this file's own transactions, where the id-scoping convention TEN-2
 * checks against exported functions does not apply.
 */
function insertCourseCategories(
  tx: Executor,
  organizationId: string,
  courseId: string,
  categories: NewCourseCategory[]
): CourseCategoryWithChannels[] {
  const now = Date.now()
  return categories.map((category, categoryIndex) => {
    const categoryId = crypto.randomUUID()
    const categoryRow: CourseCategory = {
      id: categoryId,
      organizationId,
      courseId,
      name: category.name,
      ordering: categoryIndex,
      createdAt: now,
    }
    tx.insert(courseCategories).values(categoryRow).run()

    const channels = category.channels.map((channel, channelIndex) => {
      const channelRow: CourseChannel = {
        id: crypto.randomUUID(),
        organizationId,
        categoryId,
        name: channel.name,
        adminsOnly: channel.adminsOnly,
        ordering: channelIndex,
        createdAt: now,
      }
      tx.insert(courseChannels).values(channelRow).run()
      return channelRow
    })

    return { ...categoryRow, channels }
  })
}

/**
 * Delete every category (and, through it, every channel) currently attached
 * to `courseId` — the first half of "replace a course's categories
 * coherently rather than leaving orphans" on update. Channels are deleted
 * first: nothing here relies on `ON DELETE CASCADE` (not part of D-2's
 * portable subset as used elsewhere in this package), so the child rows
 * have to go before their parent explicitly.
 */
function deleteCourseCategories(tx: Executor, courseId: string): void {
  const existingCategoryIds = tx
    .select({ id: courseCategories.id })
    .from(courseCategories)
    .where(eq(courseCategories.courseId, courseId))
    .all()
    .map((row) => row.id)

  if (existingCategoryIds.length === 0) return

  tx.delete(courseChannels)
    .where(inArray(courseChannels.categoryId, existingCategoryIds))
    .run()
  tx.delete(courseCategories)
    .where(eq(courseCategories.courseId, courseId))
    .run()
}

/**
 * Create a course with its categories and channels.
 *
 * Refused (PROJ-3) when a category name or either role name collides with
 * another enabled course's, in a non-archived project, in this
 * organization — the refusal names what it collided with rather than just
 * failing.
 */
export function createCourse(
  organizationId: string,
  input: NewCourse,
  db: Database
): SaveCourseResult {
  const conflictFound = findCourseNameConflict(organizationId, input, db)
  if (conflictFound) return { ok: false, conflict: conflictFound }

  return db.transaction((tx) => {
    const courseId = input.id ?? crypto.randomUUID()
    const courseRow = tx
      .insert(courses)
      .values({
        id: courseId,
        organizationId,
        projectId: input.projectId,
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
        createdAt: Date.now(),
      })
      .returning()
      .get()

    const categories = insertCourseCategories(
      tx,
      organizationId,
      courseId,
      input.categories
    )

    return { ok: true, course: { ...courseRow, categories } }
  })
}

/** Look up a course by id, scoped to `organizationId`, with its categories and channels in order. */
export function getCourse(
  organizationId: string,
  courseId: string,
  db: Database
): CourseWithCategories | undefined {
  const courseRow = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!courseRow) return undefined

  const categoryRows = db
    .select()
    .from(courseCategories)
    .where(
      and(
        eq(courseCategories.courseId, courseId),
        eq(courseCategories.organizationId, organizationId)
      )
    )
    .orderBy(courseCategories.ordering)
    .all()

  const categories = categoryRows.map((category) => ({
    ...category,
    channels: db
      .select()
      .from(courseChannels)
      .where(
        and(
          eq(courseChannels.categoryId, category.id),
          eq(courseChannels.organizationId, organizationId)
        )
      )
      .orderBy(courseChannels.ordering)
      .all(),
  }))

  return { ...courseRow, categories }
}

/** List an organization's courses (base rows only — use `getCourse` for categories and channels). */
export function listCourses(
  organizationId: string,
  db: Database,
  options?: { projectId?: string }
): Course[] {
  const conditions = [eq(courses.organizationId, organizationId)]
  if (options?.projectId) {
    conditions.push(eq(courses.projectId, options.projectId))
  }
  return db
    .select()
    .from(courses)
    .where(and(...conditions))
    .all()
}

/**
 * Update a course and replace its categories and channels.
 *
 * `undefined` when `courseId` does not exist or does not belong to
 * `organizationId` (TEN-2/TEN-5) — checked before the PROJ-3 collision
 * check, so a caller cannot learn anything about another organization's
 * course by way of a conflict message. Refused (PROJ-3) the same way
 * `createCourse` is, with `excludeCourseId` set to `courseId` so a no-op
 * re-save (or a rename that keeps every name distinct) is never refused for
 * colliding with itself.
 */
export function updateCourse(
  organizationId: string,
  courseId: string,
  input: NewCourse,
  db: Database
): SaveCourseResult | undefined {
  const existing = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!existing) return undefined

  const conflictFound = findCourseNameConflict(
    organizationId,
    input,
    db,
    courseId
  )
  if (conflictFound) return { ok: false, conflict: conflictFound }

  return db.transaction((tx) => {
    const courseRow = tx
      .update(courses)
      .set({
        projectId: input.projectId,
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
      })
      .where(
        and(
          eq(courses.id, courseId),
          eq(courses.organizationId, organizationId)
        )
      )
      .returning()
      .get()

    // Replace categories and channels coherently: delete the old set, then
    // insert the new one, rather than diffing row by row — a course's
    // categories are always saved as a whole (CFG-4's list), so there is no
    // partial-update case that needs anything finer.
    deleteCourseCategories(tx, courseId)
    const categories = insertCourseCategories(
      tx,
      organizationId,
      courseId,
      input.categories
    )

    return { ok: true, course: { ...courseRow, categories } }
  })
}

/**
 * Enable a disabled course.
 *
 * Returns the number of rows changed — `0` for a course that does not exist,
 * does not belong to `organizationId`, or is already enabled. Enabling does
 * not re-run the PROJ-3 check: that check applies to `createCourse` and
 * `updateCourse`, the two places new names are introduced (see the brief
 * for this slice) — re-enabling a course whose names now collide with one
 * created while it was disabled is a gap noted in this slice's report, not
 * handled here.
 */
export function enableCourse(
  organizationId: string,
  courseId: string,
  db: Database
): number {
  const result = db
    .update(courses)
    .set({ enabled: true })
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .run()
  return result.changes
}

/**
 * Disable a course (PROJ-3's other escape hatch alongside archiving its
 * project): a disabled course stops routing and is excluded from the
 * name-collision check, freeing its names for another course to use.
 *
 * Returns the number of rows changed — `0` rather than a different
 * organization's course when `organizationId` does not match.
 */
export function disableCourse(
  organizationId: string,
  courseId: string,
  db: Database
): number {
  const result = db
    .update(courses)
    .set({ enabled: false })
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .run()
  return result.changes
}
