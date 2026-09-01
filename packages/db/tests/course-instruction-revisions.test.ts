import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  courseInstructionRevisions,
  courses,
  organizations,
  projects,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one course and one account, synthetic data only (QA-3). */
function seedTwoOrganizationsWithCourses(testDatabase: TestDatabase) {
  const orgA = randomUUID()
  const orgB = randomUUID()
  organizations.createOrganization(
    orgA,
    { name: 'Org A', isPersonal: false },
    testDatabase.db
  )
  organizations.createOrganization(
    orgB,
    { name: 'Org B', isPersonal: false },
    testDatabase.db
  )
  const accountA = accounts.createAccount(
    orgA,
    { email: 'a@example.edu', displayName: 'A', role: 'owner' },
    testDatabase.db
  )
  const projectA = projects.createProject(
    orgA,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const projectB = projects.createProject(
    orgB,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const courseA = courses.createCourse(
    orgA,
    {
      projectId: projectA.id,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    testDatabase.db
  )
  const courseB = courses.createCourse(
    orgB,
    {
      projectId: projectB.id,
      title: 'Data Structures',
      filePrefix: 'ds',
      enabled: true,
      adminsRole: 'admins-ds',
      studentsRole: 'students-ds',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseA.ok || !courseB.ok) throw new Error('seed course save failed')
  return {
    orgA,
    orgB,
    accountA,
    courseA: courseA.course,
    courseB: courseB.course,
  }
}

describe('course-instruction-revisions repo (FILE-4)', () => {
  // FILE-4: three saves produce three revisions with authors and times.
  it('three saves produce three revisions, each with an author and a time', () => {
    testDb = createTestDatabase()
    const { orgA, accountA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    for (const text of ['v1', 'v2', 'v3']) {
      courseInstructionRevisions.createRevision(
        orgA,
        {
          courseId: courseA.id,
          instructions: text,
          savedByAccountId: accountA.id,
        },
        testDb.db
      )
    }

    const revisions = courseInstructionRevisions.listRevisionsForCourse(
      orgA,
      courseA.id,
      testDb.db
    )
    expect(revisions).toHaveLength(3)
    // Newest first.
    expect(revisions.map((r) => r.instructions)).toEqual(['v3', 'v2', 'v1'])
    for (const revision of revisions) {
      expect(revision.savedByAccountId).toBe(accountA.id)
      expect(typeof revision.createdAt).toBe('number')
    }
  })

  // FILE-4: restoring an earlier revision does not delete the later one.
  it('a restore adds a new revision and never deletes or rewrites an earlier one', () => {
    testDb = createTestDatabase()
    const { orgA, accountA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    const first = courseInstructionRevisions.createRevision(
      orgA,
      {
        courseId: courseA.id,
        instructions: 'be kind',
        savedByAccountId: accountA.id,
      },
      testDb.db
    )
    courseInstructionRevisions.createRevision(
      orgA,
      {
        courseId: courseA.id,
        instructions: 'be terse',
        savedByAccountId: accountA.id,
      },
      testDb.db
    )

    // "Restore" is just another save of the earlier text — its own new
    // revision, never a rewrite of `first`.
    courseInstructionRevisions.createRevision(
      orgA,
      {
        courseId: courseA.id,
        instructions: first.instructions,
        savedByAccountId: accountA.id,
      },
      testDb.db
    )

    const revisions = courseInstructionRevisions.listRevisionsForCourse(
      orgA,
      courseA.id,
      testDb.db
    )
    expect(revisions).toHaveLength(3)
    // The original `first` row is untouched.
    const stillThere = courseInstructionRevisions.getRevision(
      orgA,
      first.id,
      testDb.db
    )
    expect(stillThere).toEqual(first)
  })

  it("another organization's revisions are not readable or listable", () => {
    testDb = createTestDatabase()
    const { orgA, orgB, accountA, courseA } =
      seedTwoOrganizationsWithCourses(testDb)
    const revision = courseInstructionRevisions.createRevision(
      orgA,
      {
        courseId: courseA.id,
        instructions: 'secret',
        savedByAccountId: accountA.id,
      },
      testDb.db
    )

    expect(
      courseInstructionRevisions.getRevision(orgB, revision.id, testDb.db)
    ).toBeUndefined()
    expect(
      courseInstructionRevisions.listRevisionsForCourse(
        orgB,
        courseA.id,
        testDb.db
      )
    ).toEqual([])
  })
})
