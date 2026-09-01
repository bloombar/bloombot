/**
 * ACT-2: the entity `execute` receives is the one the policy resolved, and
 * an action cannot reach another organization's record even when it is
 * handed that record's id in its input — the policy is what scopes it, not
 * `execute` reading `input` itself.
 */

import { courses, projects, type Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  disableCourseAction,
  enableCourseAction,
  saveCourseAction,
} from '../src/actions/courses.js'
import { archiveProjectAction } from '../src/actions/projects.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import type { Action } from '../src/types.js'
import { seedOrganizationWithProject } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

/** A minimal course, created directly through the repo (not through `dispatch`) so a test can seed a scenario `courses.save`/`enable`/`disable` are then checked against. */
function seedCourse(
  organizationId: string,
  projectId: string,
  db: Database,
  overrides: Partial<{
    title: string
    filePrefix: string
    enabled: boolean
    adminsRole: string
    studentsRole: string
  }> = {}
) {
  const result = courses.createCourse(
    organizationId,
    {
      projectId,
      title: overrides.title ?? 'Seeded Course',
      filePrefix: overrides.filePrefix ?? 'sc',
      enabled: overrides.enabled ?? true,
      adminsRole: overrides.adminsRole ?? 'admins-seeded',
      studentsRole: overrides.studentsRole ?? 'students-seeded',
      categories: [],
    },
    db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return result.course
}

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('ACT-2 — the policy scopes the entity execute receives', () => {
  it("a ported action refuses another organization's record, even handed its id, before execute ever runs", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        archiveProjectAction,
        { projectId: projectBId },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    // Org B's project is untouched — the action never reached it, because
    // the policy refused before `execute` (which archives by `entity.id`,
    // never `input.projectId`) ever ran.
    expect(
      projects.getProject(orgB, projectBId, testDb.db)?.archivedAt
    ).toBeNull()
  })

  it('execute receives exactly the entity the policy resolved, not a value execute derives from input itself', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithProject(testDb.db)
    const project = projects.createProject(
      organizationId,
      { name: 'Spring 2027' },
      testDb.db
    )

    let receivedEntity: unknown
    const probe: Action<
      'test.probe',
      { projectId: string },
      { id: string; name: string },
      null
    > = {
      name: 'test.probe',
      description: 'Records the entity execute is actually handed.',
      inputSchema: z.object({ projectId: z.string().min(1) }),
      policy: {
        descriptor: { resource: 'project', access: 'read' },
        resolve: (input, context) =>
          projects.getProject(
            context.organizationId,
            input.projectId,
            context.db
          ),
      },
      execute: ({ entity }) => {
        receivedEntity = entity
        return null
      },
    }

    await dispatch(
      probe,
      { projectId: project.id },
      {
        organizationId,
        db: testDb.db,
      }
    )

    expect(receivedEntity).toMatchObject({
      id: project.id,
      name: 'Spring 2027',
    })
  })

  it("archiving through the action does not touch another organization's project of the same shape", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, projectId: projectAId } =
      seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)

    await dispatch(
      archiveProjectAction,
      { projectId: projectAId },
      { organizationId: orgA, db: testDb.db }
    )

    expect(
      projects.getProject(orgA, projectAId, testDb.db)?.archivedAt
    ).not.toBeNull()
    // Org B's own project (created independently, in the same call) is
    // untouched — dispatching against org A never reaches it.
    expect(
      projects.getProject(orgB, projectBId, testDb.db)?.archivedAt
    ).toBeNull()
  })
})

// Finding 5 (rework pass): `projects.archive` was the only two-step policy
// with a cross-tenant regression test. `courses.save` resolves the target
// project *and*, on update, the existing course — the only place a tenant
// check can be half-done — and `courses.enable`/`courses.disable` each
// resolve a course by id the same way `projects.archive` resolves a
// project. Deleting the `if (!existingCourse) return undefined` line at
// `actions/courses.ts:90` leaves the rest of the suite green while making
// it possible to update another organization's course; these tests catch
// exactly that.
describe('ACT-2 — courses.save, courses.enable, courses.disable scope by organization', () => {
  it("courses.save refuses to update another organization's course, even when projectId is the caller's own", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, projectId: projectAId } =
      seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)
    const courseB = seedCourse(orgB, projectBId, testDb.db, {
      title: 'Org B Course',
    })

    await expect(
      dispatch(
        saveCourseAction,
        {
          id: courseB.id,
          projectId: projectAId,
          title: 'Hijacked',
          filePrefix: 'hj',
          enabled: true,
          adminsRole: 'admins-hijack',
          studentsRole: 'students-hijack',
          categories: [],
        },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    // Org B's course is untouched — the policy refused before `execute`
    // (which updates by `entity.existingCourse.id`, never `input.id`) ever
    // ran.
    expect(courses.getCourse(orgB, courseB.id, testDb.db)?.title).toBe(
      'Org B Course'
    )
  })

  it("courses.enable refuses to enable another organization's course", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)
    const courseB = seedCourse(orgB, projectBId, testDb.db, {
      enabled: false,
      adminsRole: 'admins-orgb-enable',
      studentsRole: 'students-orgb-enable',
    })

    await expect(
      dispatch(
        enableCourseAction,
        { courseId: courseB.id },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(courses.getCourse(orgB, courseB.id, testDb.db)?.enabled).toBe(false)
  })

  it("courses.disable refuses to disable another organization's course", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)
    const courseB = seedCourse(orgB, projectBId, testDb.db, {
      adminsRole: 'admins-orgb-disable',
      studentsRole: 'students-orgb-disable',
    })

    await expect(
      dispatch(
        disableCourseAction,
        { courseId: courseB.id },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(courses.getCourse(orgB, courseB.id, testDb.db)?.enabled).toBe(true)
  })
})
