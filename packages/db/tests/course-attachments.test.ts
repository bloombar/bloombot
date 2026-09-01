import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  courseAttachments,
  courses,
  organizations,
  projects,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one course, synthetic data only (QA-3). */
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
  return { orgA, orgB, courseA: courseA.course, courseB: courseB.course }
}

describe('course-attachments repo (FILE-1..3, FILE-5)', () => {
  it('creates a pending attachment, then moves it to ready carrying the providers id', () => {
    testDb = createTestDatabase()
    const { orgA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    const created = courseAttachments.createPendingAttachment(
      orgA,
      {
        courseId: courseA.id,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      },
      testDb.db
    )
    expect(created.status).toBe('pending')
    expect(created.providerFileId).toBeNull()

    const ready = courseAttachments.markAttachmentReady(
      orgA,
      created.id,
      'file_abc123',
      testDb.db
    )
    expect(ready?.status).toBe('ready')
    expect(ready?.providerFileId).toBe('file_abc123')
  })

  it('a rejected upload is marked failed, carrying the providers own reason (FILE-2)', () => {
    testDb = createTestDatabase()
    const { orgA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    const created = courseAttachments.createPendingAttachment(
      orgA,
      {
        courseId: courseA.id,
        filename: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: 10,
      },
      testDb.db
    )

    const failed = courseAttachments.markAttachmentFailed(
      orgA,
      created.id,
      'unsupported file type',
      testDb.db
    )
    expect(failed?.status).toBe('failed')
    expect(failed?.failureReason).toBe('unsupported file type')
    expect(failed?.providerFileId).toBeNull()
  })

  it('lists only a courses own attachments', () => {
    testDb = createTestDatabase()
    const { orgA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    courseAttachments.createPendingAttachment(
      orgA,
      {
        courseId: courseA.id,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    courseAttachments.createPendingAttachment(
      orgA,
      {
        courseId: courseA.id,
        filename: 'b.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2,
      },
      testDb.db
    )

    const listed = courseAttachments.listAttachmentsForCourse(
      orgA,
      courseA.id,
      testDb.db
    )
    expect(listed.map((a) => a.filename).sort()).toEqual(['a.pdf', 'b.pdf'])
  })

  // FILE-5 — another organization's attachment is not readable, listable or
  // detachable: the same TEN-5 "identical not-found" every other scoped repo
  // holds itself to.
  it("FILE-5: another organization's attachment is not readable, listable or deletable — identical not-found", () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA } = seedTwoOrganizationsWithCourses(testDb)

    const created = courseAttachments.createPendingAttachment(
      orgA,
      {
        courseId: courseA.id,
        filename: 'private.pdf',
        contentType: 'application/pdf',
        sizeBytes: 5,
      },
      testDb.db
    )

    // Not readable from orgB.
    expect(
      courseAttachments.getAttachment(orgB, created.id, testDb.db)
    ).toBeUndefined()

    // Not listable from orgB, even scoped to orgA's own course id.
    expect(
      courseAttachments.listAttachmentsForCourse(orgB, courseA.id, testDb.db)
    ).toEqual([])

    // Not writable from orgB.
    expect(
      courseAttachments.markAttachmentReady(
        orgB,
        created.id,
        'file_x',
        testDb.db
      )
    ).toBeUndefined()
    expect(
      courseAttachments.markAttachmentFailed(
        orgB,
        created.id,
        'nope',
        testDb.db
      )
    ).toBeUndefined()

    // Not deletable from orgB — the row survives, untouched.
    expect(
      courseAttachments.deleteAttachment(orgB, created.id, testDb.db)
    ).toBe(false)
    expect(
      courseAttachments.getAttachment(orgA, created.id, testDb.db)
    ).toBeDefined()

    // orgA can delete its own.
    expect(
      courseAttachments.deleteAttachment(orgA, created.id, testDb.db)
    ).toBe(true)
    expect(
      courseAttachments.getAttachment(orgA, created.id, testDb.db)
    ).toBeUndefined()
  })
})
