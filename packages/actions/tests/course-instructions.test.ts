/**
 * `courseInstructions.save`/`.list`/`.restore` (FILE-4, FILE-5, D-3) —
 * against a real, throwaway database (never `data/`, QA-2, QA-3).
 */

import { accounts, courses, projects, type Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  listCourseInstructionRevisionsAction,
  restoreCourseInstructionRevisionAction,
  saveCourseInstructionsAction,
} from '../src/actions/course-instructions.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganization } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One bare course and one account to author its revisions with. */
function seedCourseWithAuthor(
  organizationId: string,
  db: Database
): { courseId: string; accountId: string } {
  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )
  const result = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: 'admins-tc',
      studentsRole: 'students-tc',
      categories: [],
    },
    db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  const account = accounts.createAccount(
    organizationId,
    {
      email: 'instructor@example.edu',
      displayName: 'Instructor',
      role: 'owner',
    },
    db
  )
  return { courseId: result.course.id, accountId: account.id }
}

describe('courseInstructions.save (FILE-4)', () => {
  it("updates the course's instructions and records an authored revision", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const { courseId, accountId } = seedCourseWithAuthor(
      organizationId,
      testDb.db
    )

    const updated = await dispatch(
      saveCourseInstructionsAction,
      { courseId, instructions: 'Be kind and cite the syllabus.' },
      { organizationId, db: testDb.db, accountId }
    )

    expect(updated.instructions).toBe('Be kind and cite the syllabus.')

    const revisions = await dispatch(
      listCourseInstructionRevisionsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toMatchObject({
      instructions: 'Be kind and cite the syllabus.',
      savedByAccountId: accountId,
    })
  })

  // FILE-4: three saves produce three revisions with authors and times.
  it('three saves produce three revisions, each with an author and a time', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const { courseId, accountId } = seedCourseWithAuthor(
      organizationId,
      testDb.db
    )

    for (const text of ['v1', 'v2', 'v3']) {
      await dispatch(
        saveCourseInstructionsAction,
        { courseId, instructions: text },
        { organizationId, db: testDb.db, accountId }
      )
    }

    const revisions = await dispatch(
      listCourseInstructionRevisionsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )
    expect(revisions).toHaveLength(3)
    expect(revisions.map((r) => r.instructions)).toEqual(['v3', 'v2', 'v1'])
    for (const revision of revisions) {
      expect(revision.savedByAccountId).toBe(accountId)
      expect(typeof revision.createdAt).toBe('number')
    }
  })

  // A self-reported author is never accepted — dispatched with no
  // `accountId` at all is refused outright, never recorded as authored by
  // nobody.
  it('refuses a save with no authenticated caller', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const { courseId } = seedCourseWithAuthor(organizationId, testDb.db)

    await expect(
      dispatch(
        saveCourseInstructionsAction,
        { courseId, instructions: 'no author' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })

  // A rework finding: `setCourseInstructions` and `createRevision` used to
  // be two untransacted writes under a comment claiming atomicity. An
  // `accountId` that authenticates (truthy, so `requireAccountId` accepts
  // it) but names no real account row makes `createRevision`'s insert fail
  // its foreign-key check (`course_instruction_revisions.saved_by_account_id`,
  // `schema.ts`) — this proves the instructions write rolls back with it,
  // rather than leaving the course changed with no revision recording it.
  it('rolls back the instructions write when recording the revision fails', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const { courseId } = seedCourseWithAuthor(organizationId, testDb.db)
    const before = courses.getCourse(organizationId, courseId, testDb.db)

    await expect(
      dispatch(
        saveCourseInstructionsAction,
        { courseId, instructions: 'never lands' },
        {
          organizationId,
          db: testDb.db,
          accountId: 'no-such-account',
        }
      )
    ).rejects.toThrow()

    const after = courses.getCourse(organizationId, courseId, testDb.db)
    expect(after?.instructions).toBe(before?.instructions)

    const revisions = await dispatch(
      listCourseInstructionRevisionsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )
    expect(revisions).toHaveLength(0)
  })

  it("does not reach another organization's course", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const { courseId, accountId } = seedCourseWithAuthor(
      organizationId,
      testDb.db
    )

    await expect(
      dispatch(
        saveCourseInstructionsAction,
        { courseId, instructions: 'nope' },
        { organizationId: otherOrganizationId, db: testDb.db, accountId }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseInstructions.restore (FILE-4)', () => {
  // FILE-4: restoring an earlier revision makes it current and does not
  // delete the later revision.
  it('restoring an earlier revision makes it current, and adds a new revision without deleting the later one', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const { courseId, accountId } = seedCourseWithAuthor(
      organizationId,
      testDb.db
    )

    await dispatch(
      saveCourseInstructionsAction,
      { courseId, instructions: 'be kind' },
      { organizationId, db: testDb.db, accountId }
    )
    const afterFirst = await dispatch(
      listCourseInstructionRevisionsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )
    const firstRevisionId = afterFirst[0]!.id

    await dispatch(
      saveCourseInstructionsAction,
      { courseId, instructions: 'be terse' },
      { organizationId, db: testDb.db, accountId }
    )

    const restored = await dispatch(
      restoreCourseInstructionRevisionAction,
      { revisionId: firstRevisionId },
      { organizationId, db: testDb.db, accountId }
    )
    expect(restored.instructions).toBe('be kind')

    const finalRevisions = await dispatch(
      listCourseInstructionRevisionsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )
    // Three revisions now: "be kind", "be terse", and the restore's own new
    // "be kind" — the original "be terse" row is still there, untouched.
    expect(finalRevisions).toHaveLength(3)
    expect(finalRevisions.map((r) => r.instructions)).toEqual([
      'be kind',
      'be terse',
      'be kind',
    ])
    expect(finalRevisions.some((r) => r.id === firstRevisionId)).toBe(true)
  })

  it('refuses to restore a revision belonging to another organization', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const { courseId, accountId } = seedCourseWithAuthor(
      organizationId,
      testDb.db
    )
    await dispatch(
      saveCourseInstructionsAction,
      { courseId, instructions: 'secret' },
      { organizationId, db: testDb.db, accountId }
    )
    const revisions = await dispatch(
      listCourseInstructionRevisionsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )

    await expect(
      dispatch(
        restoreCourseInstructionRevisionAction,
        { revisionId: revisions[0]!.id },
        { organizationId: otherOrganizationId, db: testDb.db, accountId }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})
