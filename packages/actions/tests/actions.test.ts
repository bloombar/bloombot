/**
 * The ported actions, each exercised through `dispatch` rather than by
 * calling the underlying repo directly — so a regression in the policy or
 * in how `execute` threads its arguments shows up here, not only in
 * `packages/db`'s own tests.
 */

import { courses, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  archiveProjectAction,
  createProjectAction,
  disableCourseAction,
  enableCourseAction,
  saveCourseAction,
  unarchiveProjectAction,
} from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { ActionConflictError } from '../src/errors.js'
import { seedOrganizationWithProject } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * A minimal, always-valid `courses.save` input against `projectId`,
 * overridable per test. The five optional fields (`promptId`,
 * `instructions`, `model`, `vectorStoreId`, `maxRequestsPerDay`) and
 * `conversationScope` are only included in the returned input when the
 * caller's own `overrides` object actually has the key — via `in`, not
 * `??` — so a test can tell "omit this field" (finding 2's preserve case)
 * apart from "pass it as `null`" (finding 2's clear case) the same way a
 * real caller's JSON payload would.
 */
function courseSaveInput(
  projectId: string,
  overrides: Partial<{
    id: string
    title: string
    filePrefix: string
    enabled: boolean
    adminsRole: string
    studentsRole: string
    promptId: string | null
    instructions: string | null
    model: string | null
    vectorStoreId: string | null
    maxRequestsPerDay: number | null
    conversationScope: 'course' | 'course_surface'
    categories: {
      name: string
      channels: { name: string; adminsOnly: boolean }[]
    }[]
  }> = {}
) {
  return {
    projectId,
    title: overrides.title ?? 'Web Design',
    filePrefix: overrides.filePrefix ?? 'wd',
    enabled: overrides.enabled ?? true,
    adminsRole: overrides.adminsRole ?? 'admins-wd-fa26',
    studentsRole: overrides.studentsRole ?? 'students-wd-fa26',
    categories: overrides.categories ?? [
      {
        name: 'Web Design - GLOBAL',
        channels: [{ name: 'chat', adminsOnly: false }],
      },
    ],
    ...(overrides.id ? { id: overrides.id } : {}),
    ...('promptId' in overrides ? { promptId: overrides.promptId } : {}),
    ...('instructions' in overrides
      ? { instructions: overrides.instructions }
      : {}),
    ...('model' in overrides ? { model: overrides.model } : {}),
    ...('vectorStoreId' in overrides
      ? { vectorStoreId: overrides.vectorStoreId }
      : {}),
    ...('maxRequestsPerDay' in overrides
      ? { maxRequestsPerDay: overrides.maxRequestsPerDay }
      : {}),
    ...('conversationScope' in overrides
      ? { conversationScope: overrides.conversationScope }
      : {}),
  }
}

describe('projects.create', () => {
  it("creates a project in the caller's organization", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId

    const project = await dispatch(
      createProjectAction,
      { name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    expect(project).toMatchObject({ organizationId, name: 'Spring 2027' })
    expect(
      projects.listProjects(organizationId, testDb.db).map((p) => p.name)
    ).toContain('Spring 2027')
  })

  // Finding 3 (rework pass): `createProject` (`repos/projects.ts`) leaves
  // its own name collision unhandled by design (D-12) and lets
  // `SQLITE_CONSTRAINT_UNIQUE` propagate — without the fix, this throws a
  // raw `SqliteError` naming a column, not `ActionConflictError`.
  it('refuses a duplicate project name with a typed conflict, not a raw driver error', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    await dispatch(
      createProjectAction,
      { name: 'Fall 2027' },
      { organizationId, db: testDb.db }
    )

    const attempt = dispatch(
      createProjectAction,
      { name: 'Fall 2027' },
      { organizationId, db: testDb.db }
    )

    await expect(attempt).rejects.toThrow(ActionConflictError)
    let error: ActionConflictError | undefined
    try {
      await attempt
    } catch (caught) {
      error = caught as ActionConflictError
    }
    expect(error?.conflict).toMatchObject({ name: 'Fall 2027' })
  })
})

describe('projects.archive / projects.unarchive', () => {
  it('archiving a project through the action stops its enabled course from routing', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')
    expect(courses.listRoutableCourses(organizationId, testDb.db)).toHaveLength(
      1
    )

    const result = await dispatch(
      archiveProjectAction,
      { projectId },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ archived: true })
    expect(courses.listRoutableCourses(organizationId, testDb.db)).toHaveLength(
      0
    )
    // Nothing deleted — the course is still readable.
    expect(
      courses.getCourse(organizationId, created.course.id, testDb.db)
    ).toMatchObject({
      title: 'Web Design',
    })
  })

  it('unarchiving through the action resumes routing', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')
    await dispatch(
      archiveProjectAction,
      { projectId },
      { organizationId, db: testDb.db }
    )

    const project = await dispatch(
      unarchiveProjectAction,
      { projectId },
      { organizationId, db: testDb.db }
    )

    expect(project.archivedAt).toBeNull()
    expect(courses.listRoutableCourses(organizationId, testDb.db)).toHaveLength(
      1
    )
  })

  // Finding 4 (rework pass): archiving an already-archived project used to
  // report `{ archived: false }` (rows-changed, `0`) — a caller would
  // reasonably read that as "the write failed," when the project was
  // archived the whole time.
  it('archiving an already-archived project still reports it as archived', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    await dispatch(
      archiveProjectAction,
      { projectId },
      { organizationId, db: testDb.db }
    )

    const result = await dispatch(
      archiveProjectAction,
      { projectId },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ archived: true })
  })

  // Finding 6 (rework pass): `findProjectUnarchiveConflict`
  // (`repos/courses.ts`) is what `unarchiveProject` calls to catch a name
  // freed by archiving and reused by another enabled course elsewhere while
  // this project was archived — exercised by no test before this one.
  it('refuses to unarchive a project whose course names were reused while it was archived', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId: projectAId } =
      seedOrganizationWithProject(testDb.db, 'Term A')
    const courseA = courses.createCourse(
      organizationId,
      courseSaveInput(projectAId, {
        title: 'Course A',
        adminsRole: 'admins-shared',
        studentsRole: 'students-a',
        categories: [{ name: 'A-cat', channels: [] }],
      }),
      testDb.db
    )
    if (!courseA.ok) throw new Error('setup failed: unexpected conflict')

    await dispatch(
      archiveProjectAction,
      { projectId: projectAId },
      { organizationId, db: testDb.db }
    )

    // Free while Term A is archived — Term B's course can take the same
    // admin role.
    const projectB = projects.createProject(
      organizationId,
      { name: 'Term B' },
      testDb.db
    )
    const courseB = courses.createCourse(
      organizationId,
      courseSaveInput(projectB.id, {
        title: 'Course B',
        filePrefix: 'b',
        adminsRole: 'admins-shared',
        studentsRole: 'students-b',
        categories: [{ name: 'B-cat', channels: [] }],
      }),
      testDb.db
    )
    if (!courseB.ok) throw new Error('setup failed: unexpected conflict')

    const attempt = dispatch(
      unarchiveProjectAction,
      { projectId: projectAId },
      { organizationId, db: testDb.db }
    )

    await expect(attempt).rejects.toThrow(ActionConflictError)
    // Left archived — the conflicting write never happened.
    expect(
      projects.getProject(organizationId, projectAId, testDb.db)?.archivedAt
    ).not.toBeNull()
  })
})

describe('courses.save', () => {
  it('creates a course when input carries no id', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)

    const course = await dispatch(
      saveCourseAction,
      courseSaveInput(projectId),
      { organizationId, db: testDb.db }
    )

    expect(course).toMatchObject({ title: 'Web Design', projectId })
    expect(course.categories).toHaveLength(1)
  })

  // MDL-8: a stored prompt id is only ever inherited from the Python era
  // (D-3's escape hatch), never newly acquired — even a caller that
  // supplies one explicitly on create (the panel itself no longer offers
  // the field at all, `pages/CourseEditor.tsx`) gets a course with none.
  it('MDL-8: a create ignores an explicit promptId — no new course may acquire one', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)

    const course = await dispatch(
      saveCourseAction,
      courseSaveInput(projectId, { promptId: 'prompt-from-the-python-era' }),
      { organizationId, db: testDb.db }
    )

    expect(course.promptId).toBeNull()
  })

  it('updates an existing course when input carries its id', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const updated = await dispatch(
      saveCourseAction,
      courseSaveInput(projectId, {
        id: created.course.id,
        title: 'Web Design II',
      }),
      { organizationId, db: testDb.db }
    )

    expect(updated.id).toBe(created.course.id)
    expect(updated.title).toBe('Web Design II')
  })

  it('a PROJ-3 collision surfaces as a typed conflict error naming what it collided with', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const first = courses.createCourse(
      organizationId,
      courseSaveInput(projectId, {
        title: 'Web Design',
        adminsRole: 'admins-wd-fa26',
        studentsRole: 'students-wd-fa26',
        categories: [{ name: 'GLOBAL', channels: [] }],
      }),
      testDb.db
    )
    if (!first.ok) throw new Error('setup failed: unexpected conflict')

    const attempt = dispatch(
      saveCourseAction,
      courseSaveInput(projectId, {
        title: 'Data Science',
        filePrefix: 'ds',
        adminsRole: 'admins-ds-fa26',
        // Colliding with Web Design's admins role — PROJ-3's shared pool of
        // role names, not a self-conflict (its own admin role is distinct).
        studentsRole: 'admins-wd-fa26',
        categories: [{ name: 'DS GLOBAL', channels: [] }],
      }),
      { organizationId, db: testDb.db }
    )

    await expect(attempt).rejects.toThrow(ActionConflictError)
    let error: ActionConflictError | undefined
    try {
      await attempt
    } catch (caught) {
      error = caught as ActionConflictError
    }
    expect(error?.conflict).toMatchObject({
      field: 'studentsRole',
      name: 'admins-wd-fa26',
      conflictingCourseTitle: 'Web Design',
    })
  })

  // Finding 2 (rework pass): `promptId`, `instructions`, `model`,
  // `vectorStoreId` and `maxRequestsPerDay` are optional in the input
  // schema so a partial update (e.g. renaming a course) does not have to
  // repeat every field — but that means an *omitted* field must keep its
  // stored value, not get wiped to `null`.
  it('omitting an optional field on update keeps its stored value', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId, {
        promptId: 'prompt-1',
        instructions: 'Be helpful.',
        model: 'gpt-5',
        vectorStoreId: 'vs-1',
        maxRequestsPerDay: 50,
      }),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    // Only `title` changes — every optional field is left out of the raw
    // input entirely, not set to `null`.
    const updated = await dispatch(
      saveCourseAction,
      courseSaveInput(projectId, {
        id: created.course.id,
        title: 'Web Design II',
      }),
      { organizationId, db: testDb.db }
    )

    expect(updated.title).toBe('Web Design II')
    expect(updated.promptId).toBe('prompt-1')
    expect(updated.instructions).toBe('Be helpful.')
    expect(updated.model).toBe('gpt-5')
    expect(updated.vectorStoreId).toBe('vs-1')
    expect(updated.maxRequestsPerDay).toBe(50)
  })

  it('an explicit null on update clears a previously set optional field', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId, {
        promptId: 'prompt-1',
        maxRequestsPerDay: 50,
      }),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const updated = await dispatch(
      saveCourseAction,
      courseSaveInput(projectId, {
        id: created.course.id,
        promptId: null,
        maxRequestsPerDay: null,
      }),
      { organizationId, db: testDb.db }
    )

    expect(updated.promptId).toBeNull()
    expect(updated.maxRequestsPerDay).toBeNull()
  })

  // The reproduction named in the brief: `conversationScope` is not
  // nullable, so it has no separate "clear" case, but an omitted
  // `conversationScope` on update still has to preserve `course_surface`
  // rather than resetting to the `'course'` default (CONV-1) — silently
  // re-grouping every future conversation.
  it('omitting conversationScope on update keeps its stored value instead of resetting to the default', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId, { conversationScope: 'course_surface' }),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')
    expect(created.course.conversationScope).toBe('course_surface')

    const updated = await dispatch(
      saveCourseAction,
      courseSaveInput(projectId, { id: created.course.id, title: 'Renamed' }),
      { organizationId, db: testDb.db }
    )

    expect(updated.conversationScope).toBe('course_surface')
  })
})

describe('courses.enable / courses.disable', () => {
  // `listRoutableCourses` (`repos/courses.ts`) reports a disabled course's
  // own `enabled` flag rather than excluding it — filtering it out of what
  // actually routes is `packages/core`'s `routeMessage` job (CORE-2), not
  // this repo's — so the flag itself, not routable count, is what these
  // actions are checked against.
  it('disabling then enabling a course through the action toggles its enabled flag', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const disabled = await dispatch(
      disableCourseAction,
      { courseId: created.course.id },
      { organizationId, db: testDb.db }
    )
    expect(disabled).toEqual({ disabled: true })
    expect(
      courses.getCourse(organizationId, created.course.id, testDb.db)?.enabled
    ).toBe(false)

    const enabled = await dispatch(
      enableCourseAction,
      { courseId: created.course.id },
      { organizationId, db: testDb.db }
    )
    expect(enabled).toEqual({ enabled: true })
    expect(
      courses.getCourse(organizationId, created.course.id, testDb.db)?.enabled
    ).toBe(true)
  })

  // Finding 4 (rework pass): enabling an already-enabled course used to
  // report `{ enabled: false }` (rows-changed, `0`) while the course stayed
  // enabled the whole time — a caller would reasonably read that as "the
  // write failed."
  it('enabling an already-enabled course still reports it as enabled', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      enableCourseAction,
      { courseId: created.course.id },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ enabled: true })
  })

  it('disabling an already-disabled course still reports it as disabled', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      courseSaveInput(projectId),
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')
    await dispatch(
      disableCourseAction,
      { courseId: created.course.id },
      { organizationId, db: testDb.db }
    )

    const result = await dispatch(
      disableCourseAction,
      { courseId: created.course.id },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ disabled: true })
  })

  // Finding 6 (rework pass): `enableCourse` (`repos/courses.ts`) re-runs
  // PROJ-3's check specifically because a course disabled while another
  // course took its names, then re-enabled, would otherwise produce two
  // enabled courses sharing a role name — exercised by no test before this
  // one.
  it('refuses to enable a course whose role name was reused while it was disabled', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const courseA = courses.createCourse(
      organizationId,
      courseSaveInput(projectId, {
        title: 'Course A',
        adminsRole: 'admins-shared',
        studentsRole: 'students-a',
        categories: [{ name: 'A-cat', channels: [] }],
      }),
      testDb.db
    )
    if (!courseA.ok) throw new Error('setup failed: unexpected conflict')

    await dispatch(
      disableCourseAction,
      { courseId: courseA.course.id },
      { organizationId, db: testDb.db }
    )

    // Free while Course A is disabled — Course B can take the same admin
    // role.
    const courseB = courses.createCourse(
      organizationId,
      courseSaveInput(projectId, {
        title: 'Course B',
        filePrefix: 'b',
        adminsRole: 'admins-shared',
        studentsRole: 'students-b',
        categories: [{ name: 'B-cat', channels: [] }],
      }),
      testDb.db
    )
    if (!courseB.ok) throw new Error('setup failed: unexpected conflict')

    const attempt = dispatch(
      enableCourseAction,
      { courseId: courseA.course.id },
      { organizationId, db: testDb.db }
    )

    await expect(attempt).rejects.toThrow(ActionConflictError)
    // Left disabled — the conflicting write never happened.
    expect(
      courses.getCourse(organizationId, courseA.course.id, testDb.db)?.enabled
    ).toBe(false)
  })
})
