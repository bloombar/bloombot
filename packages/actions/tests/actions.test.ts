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

/** A minimal, always-valid `courses.save` input against `projectId`, overridable per test. */
function courseSaveInput(
  projectId: string,
  overrides: Partial<{
    id: string
    title: string
    filePrefix: string
    enabled: boolean
    adminsRole: string
    studentsRole: string
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
})
