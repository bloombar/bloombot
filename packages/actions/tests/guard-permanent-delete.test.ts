/**
 * PROJ-11 — the owner gate on the two *permanent* deletes,
 * `courses.delete`/`projects.delete`: an adversarial review of WEB-72 found
 * these actions checking no role at all while `courses.softDelete`/
 * `projects.softDelete`, the reversible delete of the same record, was
 * owner-only — the more destructive path was the less protected one. This
 * file is `tests/soft-delete.test.ts`'s own precedent, mirrored onto the
 * permanent pair: an instructor and an assistant are refused, an owner is
 * allowed, a caller who owns a different organization is refused the
 * identical way (TEN-5), and every refusal reads as not-found rather than
 * forbidden.
 */

import { accounts, courses, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { deleteCourseAction } from '../src/actions/courses.js'
import { deleteProjectAction } from '../src/actions/projects.js'
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

describe('courses.delete owner gate (PROJ-11)', () => {
  it('an owner may permanently delete a course', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    await dispatch(
      deleteCourseAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
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
        deleteCourseAction,
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
        deleteCourseAction,
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  // TEN-5 — a course belonging to another organization resolves to
  // nothing, the identical refusal an owner-check failure gives — never a
  // distinct error a caller could use to tell the two apart.
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
        deleteCourseAction,
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
        deleteCourseAction,
        { courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('projects.delete owner gate (PROJ-11)', () => {
  it('an owner may permanently delete a project', async () => {
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

    await dispatch(
      deleteProjectAction,
      { projectId },
      { organizationId, db: testDb.db, accountId: owner.id }
    )
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
        deleteProjectAction,
        { projectId },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      projects.getProject(organizationId, projectId, testDb.db)
    ).toBeDefined()
  })

  it('refuses a non-owner (assistant), deleting nothing', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'a@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        deleteProjectAction,
        { projectId },
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      projects.getProject(organizationId, projectId, testDb.db)
    ).toBeDefined()
  })

  // TEN-5 — a project belonging to another organization resolves to
  // nothing, the identical refusal an owner-check failure gives.
  it('refuses a caller who owns a different organization (TEN-5)', async () => {
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
        deleteProjectAction,
        { projectId },
        { organizationId, db: testDb.db, accountId: otherOwner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      projects.getProject(organizationId, projectId, testDb.db)
    ).toBeDefined()
  })

  it('refuses a caller with no account id at all', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        deleteProjectAction,
        { projectId },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})
