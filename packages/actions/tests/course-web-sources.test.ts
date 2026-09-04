/**
 * FILE-6, WEB-31: `courseWebSources.add`/`.list`/`.remove` — dispatched
 * actions, modelled on `course-join-links.test.ts`'s own shape.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  addCourseWebSourceAction,
  listCourseWebSourcesAction,
  removeCourseWebSourceAction,
} from '../src/actions/course-web-sources.js'
import { dispatch } from '../src/dispatch.js'
import {
  ActionConflictError,
  ActionInputError,
  ActionRefusedError,
} from '../src/errors.js'
import { seedOrganization, seedOrganizationWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('courseWebSources.add (FILE-6, WEB-31)', () => {
  it('reduces a full URL to its bare domain and stores that', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const result = await dispatch(
      addCourseWebSourceAction,
      { courseId: course.id, domain: 'https://Example.edu/some/path' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result.domain).toBe('example.edu')
    expect(result.courseId).toBe(course.id)
  })

  it('refuses an input that does not reduce to a domain, with a plain-English reason', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    await expect(
      dispatch(
        addCourseWebSourceAction,
        { courseId: course.id, domain: 'not a domain' },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toBeInstanceOf(ActionInputError)
  })

  it('adding an existing domain refuses with a named conflict, not a duplicate row or an opaque error', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    await dispatch(
      addCourseWebSourceAction,
      { courseId: course.id, domain: 'example.edu' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    await expect(
      dispatch(
        addCourseWebSourceAction,
        { courseId: course.id, domain: 'https://example.edu/' },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toBeInstanceOf(ActionConflictError)

    const listed = await dispatch(
      listCourseWebSourcesAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(listed).toHaveLength(1)
  })

  it('refuses a course id belonging to another organization (ACT-2/TEN-5)', async () => {
    testDb = createTestDatabase()
    const { course } = seedOrganizationWithCourse(testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        addCourseWebSourceAction,
        { courseId: course.id, domain: 'example.edu' },
        { organizationId: otherOrganizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseWebSources.list (FILE-6)', () => {
  it("lists a course's websites", async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    await dispatch(
      addCourseWebSourceAction,
      { courseId: course.id, domain: 'a.example.edu' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    await dispatch(
      addCourseWebSourceAction,
      { courseId: course.id, domain: 'b.example.edu' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const listed = await dispatch(
      listCourseWebSourcesAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(listed.map((source) => source.domain).sort()).toEqual([
      'a.example.edu',
      'b.example.edu',
    ])
  })
})

describe('courseWebSources.remove (FILE-6)', () => {
  it('removes a website — a later list no longer carries it', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const created = await dispatch(
      addCourseWebSourceAction,
      { courseId: course.id, domain: 'example.edu' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const result = await dispatch(
      removeCourseWebSourceAction,
      { webSourceId: created.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(result.removed).toBe(true)

    const listed = await dispatch(
      listCourseWebSourcesAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(listed).toEqual([])
  })

  it('refuses a web source id belonging to another organization (TEN-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const created = await dispatch(
      addCourseWebSourceAction,
      { courseId: course.id, domain: 'example.edu' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    await expect(
      dispatch(
        removeCourseWebSourceAction,
        { webSourceId: created.id },
        { organizationId: otherOrganizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})
