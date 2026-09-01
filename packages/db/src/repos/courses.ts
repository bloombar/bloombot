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

import { and, eq, inArray, isNull, or } from 'drizzle-orm'

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
type ProjectRow = typeof projects.$inferSelect

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

/**
 * The fields the PROJ-3 checks below (`findCourseNameConflict`,
 * `findSelfConflict`) actually need — just the two role names and the
 * category names, not a full `NewCourseCategory[]` with its channels.
 * `enableCourse` and `findProjectUnarchiveConflict` build this from rows
 * already read from the database, which never carry channels alongside a
 * category's name; `NewCourse`'s own `categories: NewCourseCategory[]` is
 * still assignable here, so `createCourse` and `updateCourse` pass `input`
 * straight through.
 */
interface NameCheckInput {
  adminsRole: string
  studentsRole: string
  categories: { name: string }[]
}

/**
 * What a save refusal names: the field, the name, and what it collided with.
 * `'projectId'` is TEN-5's guard (below), not PROJ-3's — it has no
 * conflicting course or project to name, only the id that does not belong to
 * this organization, so `conflictingProjectName`/`conflictingCourseTitle` are
 * optional rather than required for every field.
 */
export interface CourseNameConflict {
  field: 'category' | 'adminsRole' | 'studentsRole' | 'projectId'
  name: string
  conflictingProjectName?: string
  conflictingCourseTitle?: string
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
 *
 * `includeProjectId`, when set, also treats courses in that project as
 * candidates even though its `projects.archivedAt` may not be `null` yet —
 * `unarchiveProject` (`repos/projects.ts`) uses this to check what a project
 * *would* collide with before it is actually unarchived, since its own
 * courses are otherwise invisible to this check while their project is still
 * archived.
 *
 * `db` accepts `Executor`, not just `Database`: `createCourse` and
 * `updateCourse` call this from inside their own transaction (D-12's
 * "Limits" — this check has no SQL constraint backing it, so running it and
 * the write in the same transaction is the only thing this package can do to
 * narrow the race between two concurrent saves).
 */
function findCourseNameConflict(
  organizationId: string,
  input: NameCheckInput,
  db: Executor,
  options: { excludeCourseId?: string; includeProjectId?: string } = {}
): CourseNameConflict | undefined {
  const { excludeCourseId, includeProjectId } = options
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
        // not a candidate for a collision — unless `includeProjectId` names
        // it explicitly (see above).
        includeProjectId
          ? or(
              isNull(projects.archivedAt),
              eq(courses.projectId, includeProjectId)
            )
          : isNull(projects.archivedAt)
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
 * PROJ-3 within a single course: an admin and student role that are the same
 * name, or two categories that share a name, break the "unique across every
 * enabled course" invariant inside one course rather than across two — the
 * cross-course check above cannot see this, since it only ever compares
 * `input` against *other* courses. Checked before the cross-course check so
 * a self-conflicting input is refused for the reason that actually applies
 * to it, not misreported as colliding with a candidate it never reached.
 */
function findSelfConflict(
  input: NameCheckInput
): CourseNameConflict | undefined {
  if (input.adminsRole === input.studentsRole) {
    return {
      field: 'studentsRole',
      name: input.studentsRole,
      message:
        `Role name "${input.studentsRole}" is used for both the admin and ` +
        `student role of this course; they must be different.`,
    }
  }

  const seenCategoryNames = new Set<string>()
  for (const category of input.categories) {
    if (seenCategoryNames.has(category.name)) {
      return {
        field: 'category',
        name: category.name,
        message: `Category name "${category.name}" is used more than once in this course.`,
      }
    }
    seenCategoryNames.add(category.name)
  }

  return undefined
}

/**
 * TEN-5: the foreign key on `courses.project_id` only proves `projectId`
 * refers to *some* project, not that it belongs to `organizationId` — the
 * same gap `claimDiscordServerBinding` (`repos/discord-servers.ts`) closes
 * for `installedByAccountId`. Left unchecked, a course could be saved
 * against another organization's project: its refusals would then quote
 * that project's name across the tenant boundary (TEN-5), and archiving the
 * foreign project would silently drop this organization's course out of the
 * PROJ-3 candidate set.
 *
 * Refused through the same `{ ok: false, conflict }` channel as a name
 * collision, not a thrown foreign-key error, so `createCourse` and
 * `updateCourse` can return it directly.
 */
function loadOwnedProject(
  organizationId: string,
  projectId: string,
  db: Database
):
  | { ok: true; project: ProjectRow }
  | { ok: false; conflict: CourseNameConflict } {
  const project = db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId)
      )
    )
    .get()

  if (!project) {
    return {
      ok: false,
      conflict: {
        field: 'projectId',
        name: projectId,
        message: `Project "${projectId}" does not belong to this organization.`,
      },
    }
  }

  return { ok: true, project }
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
 * Refused (TEN-5) when `input.projectId` does not belong to `organizationId`
 * — `loadOwnedProject`'s guard, above. Refused (PROJ-3) when a category name
 * or either role name collides with another enabled course's, in a
 * non-archived project, in this organization, or with itself (the same
 * admin and student role, or a repeated category name) — the refusal names
 * what it collided with rather than just failing. The PROJ-3 cross-course
 * check only applies when this save would actually route — `input.enabled`
 * and a non-archived project — since a disabled course, or one in an
 * archived project, introduces no collision (`schema.ts`'s `courses.enabled`
 * comment; disabling is PROJ-3's escape hatch and must stay usable even
 * while its names are currently taken elsewhere).
 */
export function createCourse(
  organizationId: string,
  input: NewCourse,
  db: Database
): SaveCourseResult {
  const projectResult = loadOwnedProject(organizationId, input.projectId, db)
  if (!projectResult.ok) return projectResult

  const selfConflict = findSelfConflict(input)
  if (selfConflict) return { ok: false, conflict: selfConflict }

  return db.transaction((tx) => {
    // Run inside the write transaction, not before it (D-12's "Limits"):
    // with no SQL constraint backing this check, running it and the write
    // in the same transaction is what narrows the race between two
    // concurrent saves, rather than eliminating it.
    if (input.enabled && projectResult.project.archivedAt === null) {
      const conflictFound = findCourseNameConflict(organizationId, input, tx)
      if (conflictFound) return { ok: false, conflict: conflictFound }
    }

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
 * `organizationId` (TEN-2/TEN-5) — checked before the project-ownership and
 * PROJ-3 collision checks, so a caller cannot learn anything about another
 * organization's course, or another organization's project, by way of a
 * conflict message. Refused (TEN-5) when `input.projectId` does not belong
 * to `organizationId`, and refused (PROJ-3) the same way `createCourse` is,
 * with `excludeCourseId` set to `courseId` so a no-op re-save (or a rename
 * that keeps every name distinct) is never refused for colliding with
 * itself — see `createCourse` for when the PROJ-3 check applies.
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

  const projectResult = loadOwnedProject(organizationId, input.projectId, db)
  if (!projectResult.ok) return projectResult

  const selfConflict = findSelfConflict(input)
  if (selfConflict) return { ok: false, conflict: selfConflict }

  return db.transaction((tx) => {
    if (input.enabled && projectResult.project.archivedAt === null) {
      const conflictFound = findCourseNameConflict(organizationId, input, tx, {
        excludeCourseId: courseId,
      })
      if (conflictFound) return { ok: false, conflict: conflictFound }
    }

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

/** What `enableCourse` reports: `undefined` for TEN-2/TEN-5, matching `updateCourse`. */
export type EnableCourseResult =
  { ok: true; changed: boolean } | { ok: false; conflict: CourseNameConflict }

/**
 * Enable a disabled course.
 *
 * Re-runs the PROJ-3 check (`createCourse` and `updateCourse` are not the
 * only places a collision can appear: a course disabled while another course
 * took its names, then re-enabled, produces exactly the state PROJ-3
 * forbids — two enabled courses sharing a category or role name — unless
 * enabling is checked too). Refused the same way a save is, through
 * `{ ok: false, conflict }`.
 *
 * `undefined` when `courseId` does not exist or does not belong to
 * `organizationId` (TEN-2), matching `updateCourse`. Enabling an
 * already-enabled course is a no-op: `{ ok: true, changed: false }`, so a
 * caller that treats `changed` as "this actually happened" — to emit an
 * audit event, say — is not told something happened when nothing did.
 */
export function enableCourse(
  organizationId: string,
  courseId: string,
  db: Database
): EnableCourseResult | undefined {
  const existing = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!existing) return undefined
  if (existing.enabled) return { ok: true, changed: false }

  return db.transaction((tx) => {
    // `existing.projectId` was validated against `organizationId` when it
    // was last saved (`loadOwnedProject`, above) — projects are never
    // reassigned outside a save, so it does not need re-checking here.
    const project = tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, existing.projectId))
      .get()

    if (project && project.archivedAt === null) {
      const categories = tx
        .select({ name: courseCategories.name })
        .from(courseCategories)
        .where(eq(courseCategories.courseId, courseId))
        .all()
      const conflictFound = findCourseNameConflict(
        organizationId,
        {
          adminsRole: existing.adminsRole,
          studentsRole: existing.studentsRole,
          categories,
        },
        tx,
        { excludeCourseId: courseId }
      )
      if (conflictFound) return { ok: false, conflict: conflictFound }
    }

    tx.update(courses)
      .set({ enabled: true })
      .where(
        and(
          eq(courses.id, courseId),
          eq(courses.organizationId, organizationId)
        )
      )
      .run()
    return { ok: true, changed: true }
  })
}

/**
 * Disable a course (PROJ-3's other escape hatch alongside archiving its
 * project): a disabled course stops routing and is excluded from the
 * name-collision check, freeing its names for another course to use.
 *
 * Returns the number of rows changed — `0` rather than a different
 * organization's course when `organizationId` does not match, and `0` for a
 * course that is already disabled (the `enabled` predicate below, the same
 * shape `archiveProject`'s `isNull(archivedAt)` uses), so a caller cannot
 * mistake "already disabled" for "just disabled".
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
      and(
        eq(courses.id, courseId),
        eq(courses.organizationId, organizationId),
        eq(courses.enabled, true)
      )
    )
    .run()
  return result.changes
}

/**
 * The conflict unarchiving `projectId` would produce, if any: a course in an
 * archived project is excluded from the PROJ-3 candidate set
 * (`findCourseNameConflict`), so a name freed by archiving and reused by
 * another enabled course would silently collide once this project's courses
 * route again — the same hole `enableCourse` closes for a single course, one
 * level up, for every enabled course a project brings back at once.
 *
 * Checks each of `projectId`'s own enabled courses against every other
 * enabled course in a non-archived project *and* against each other
 * (`includeProjectId`) — two of this project's own courses could have taken
 * the same name while both were archived, since neither was a PROJ-3
 * candidate at the time. Called by `unarchiveProject` (`repos/projects.ts`)
 * before the project's `archived_at` is cleared.
 */
export function findProjectUnarchiveConflict(
  organizationId: string,
  projectId: string,
  db: Database
): CourseNameConflict | undefined {
  const projectCourses = db
    .select({
      id: courses.id,
      adminsRole: courses.adminsRole,
      studentsRole: courses.studentsRole,
    })
    .from(courses)
    .where(
      and(
        eq(courses.organizationId, organizationId),
        eq(courses.projectId, projectId),
        eq(courses.enabled, true)
      )
    )
    .all()

  for (const course of projectCourses) {
    const categories = db
      .select({ name: courseCategories.name })
      .from(courseCategories)
      .where(eq(courseCategories.courseId, course.id))
      .all()
    const conflictFound = findCourseNameConflict(
      organizationId,
      {
        adminsRole: course.adminsRole,
        studentsRole: course.studentsRole,
        categories,
      },
      db,
      { excludeCourseId: course.id, includeProjectId: projectId }
    )
    if (conflictFound) return conflictFound
  }

  return undefined
}
