/**
 * WEB-72/DATA-7 — the three org-scoped soft-delete actions this slice adds:
 * `organizations.softDelete`, `projects.softDelete`, `courses.softDelete`.
 * Every one of them is owner-only, the same `callerMembership` check
 * `organizations.rename` already holds itself to (`tests/organizations.test.ts`
 * is this file's own precedent, mirrored here for the identical reason) —
 * proven positively and negatively, including TEN-5's "a caller acting in
 * a different organization is refused the identical way a real refusal is."
 */

import { accounts, courses, organizations, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { softDeleteCourseAction } from '../src/actions/courses.js'
import { softDeleteOrganizationAction } from '../src/actions/organizations.js'
import { softDeleteProjectAction } from '../src/actions/projects.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import {
  seedOrganization,
  seedOrganizationWithCourse,
  seedOrganizationWithProject,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('organizations.softDelete (WEB-72/DATA-7)', () => {
  it('an owner deletes their own organization, marking it rather than removing it', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db, 'Doomed Org')
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const deleted = await dispatch(
      softDeleteOrganizationAction,
      {},
      { organizationId, db: testDb.db, accountId: owner.id }
    )
    expect(deleted.deletedAt).not.toBeNull()
    expect(deleted.deletedByAccountId).toBe(owner.id)

    // DATA-9 — gone from an ordinary read, not merely marked in the value
    // this one call happened to echo back.
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeUndefined()
  })

  it('refuses a non-owner (instructor)', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'i@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteOrganizationAction,
        {},
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
  })

  it('refuses a non-owner (assistant)', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'a@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteOrganizationAction,
        {},
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a caller with no account id at all', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)

    await expect(
      dispatch(
        softDeleteOrganizationAction,
        {},
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // TEN-5 — a caller acting in a different organization than the one they
  // own is refused the identical way a genuine refusal is, never
  // disclosing that the target organization exists.
  it('refuses a caller who owns a different organization (TEN-5)', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db, 'Target Org')
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const otherOwner = accounts.createAccount(
      otherOrganizationId,
      { email: 'owner@other.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteOrganizationAction,
        {},
        { organizationId, db: testDb.db, accountId: otherOwner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
  })
})

describe('projects.softDelete (WEB-72/DATA-7)', () => {
  it('an owner deletes a project in their own organization', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Doomed Project'
    )
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const deleted = await dispatch(
      softDeleteProjectAction,
      { projectId },
      { organizationId, db: testDb.db, accountId: owner.id }
    )
    expect(deleted.deletedAt).not.toBeNull()
    expect(
      projects.getProject(organizationId, projectId, testDb.db)
    ).toBeUndefined()
  })

  it('refuses a non-owner (instructor), deleting nothing', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'i@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteProjectAction,
        { projectId },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      projects.getProject(organizationId, projectId, testDb.db)
    ).toBeDefined()
  })

  // TEN-5 — a project belonging to another organization resolves to
  // nothing at all, the identical refusal an owner-check failure gives.
  it('refuses a caller who owns a different organization, the project’s own owner untouched (TEN-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Target Project'
    )
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const otherOwner = accounts.createAccount(
      otherOrganizationId,
      { email: 'owner@other.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteProjectAction,
        { projectId },
        { organizationId, db: testDb.db, accountId: otherOwner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      projects.getProject(organizationId, projectId, testDb.db)
    ).toBeDefined()
  })
})

describe('courses.softDelete (WEB-72/DATA-7)', () => {
  it('an owner deletes a course in their own organization', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const deleted = await dispatch(
      softDeleteCourseAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(deleted.deletedAt).not.toBeNull()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
  })

  it('refuses a non-owner (instructor), deleting nothing', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'i@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteCourseAction,
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  it('refuses a non-owner (assistant), deleting nothing', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'a@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteCourseAction,
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  // TEN-5 — a course belonging to another organization resolves to
  // nothing, the identical refusal an owner-check failure gives.
  it('refuses a caller who owns a different organization (TEN-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const otherOwner = accounts.createAccount(
      otherOrganizationId,
      { email: 'owner@other.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        softDeleteCourseAction,
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: otherOwner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  it('refuses a caller with no account id at all', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        softDeleteCourseAction,
        { courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})
