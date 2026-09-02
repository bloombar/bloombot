import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  conversations,
  courses,
  organizations,
  people,
  projects,
  transcriptAccess,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization, one course, one instructor account, and two students each with one message — synthetic data only (QA-3). */
function seedCourseWithMessages(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org A', isPersonal: false },
    testDatabase.db
  )
  const project = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  const course = courseResult.course

  const instructor = accounts.createAccount(
    organizationId,
    {
      email: 'instructor@example.edu',
      displayName: 'Instructor',
      role: 'owner',
    },
    testDatabase.db
  )

  const alice = people.createPerson(
    organizationId,
    { displayName: 'Alice' },
    testDatabase.db
  )
  const bob = people.createPerson(
    organizationId,
    { displayName: 'Bob' },
    testDatabase.db
  )

  const aliceConversation = conversations.getOrCreateConversation(
    organizationId,
    { courseId: course.id, personId: alice.id, surface: 'web' },
    testDatabase.db
  )
  const bobConversation = conversations.getOrCreateConversation(
    organizationId,
    { courseId: course.id, personId: bob.id, surface: 'web' },
    testDatabase.db
  )
  if (!aliceConversation || !bobConversation) {
    throw new Error('seed conversation creation failed')
  }

  conversations.appendMessage(
    organizationId,
    aliceConversation.id,
    {
      direction: 'from_person',
      content: 'What is the deadline?',
      createdAt: 1_000,
    },
    testDatabase.db
  )
  conversations.appendMessage(
    organizationId,
    aliceConversation.id,
    { direction: 'to_person', content: 'Friday.', createdAt: 2_000 },
    testDatabase.db
  )
  conversations.appendMessage(
    organizationId,
    bobConversation.id,
    {
      direction: 'from_person',
      content: 'Is class cancelled?',
      createdAt: 3_000,
    },
    testDatabase.db
  )

  return { organizationId, course, instructor, alice, bob }
}

describe('transcriptAccess.readCourseTranscript (ADMIN-1, ADMIN-2)', () => {
  it('reads every message in the course, in order, when no filter is given', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor } =
      seedCourseWithMessages(testDb)

    const result = transcriptAccess.readCourseTranscript(
      organizationId,
      { courseId: course.id, actorAccountId: instructor.id, kind: 'read' },
      testDb.db
    )

    expect(result?.entries).toHaveLength(3)
    expect(result?.entries.map((entry) => entry.content)).toEqual([
      'What is the deadline?',
      'Friday.',
      'Is class cancelled?',
    ])
  })

  it('filters by student (ADMIN-1)', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor, bob } =
      seedCourseWithMessages(testDb)

    const result = transcriptAccess.readCourseTranscript(
      organizationId,
      {
        courseId: course.id,
        actorAccountId: instructor.id,
        personId: bob.id,
        kind: 'read',
      },
      testDb.db
    )

    expect(result?.entries).toHaveLength(1)
    expect(result?.entries[0]?.content).toBe('Is class cancelled?')
  })

  it('filters by date range (ADMIN-1)', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor } =
      seedCourseWithMessages(testDb)

    const result = transcriptAccess.readCourseTranscript(
      organizationId,
      {
        courseId: course.id,
        actorAccountId: instructor.id,
        startAt: 1_500,
        endAt: 2_500,
        kind: 'read',
      },
      testDb.db
    )

    expect(result?.entries).toHaveLength(1)
    expect(result?.entries[0]?.content).toBe('Friday.')
  })

  // ADMIN-2 — the requirement this test exists to prove: reading a
  // transcript is itself written to an audit trail. Fails without the
  // change to `readCourseTranscript` that writes the row in the same call.
  it('writes an audit entry recording who read whose conversation, and when', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor, bob } =
      seedCourseWithMessages(testDb)
    const before = Date.now()

    transcriptAccess.readCourseTranscript(
      organizationId,
      {
        courseId: course.id,
        actorAccountId: instructor.id,
        personId: bob.id,
        kind: 'read',
      },
      testDb.db
    )

    const log = transcriptAccess.listAccessLogForCourse(
      organizationId,
      course.id,
      testDb.db
    )
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      organizationId,
      courseId: course.id,
      actorAccountId: instructor.id,
      personId: bob.id,
      kind: 'read',
    })
    expect(log[0]?.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('records an unfiltered read with personId: null', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor } =
      seedCourseWithMessages(testDb)

    transcriptAccess.readCourseTranscript(
      organizationId,
      { courseId: course.id, actorAccountId: instructor.id, kind: 'read' },
      testDb.db
    )

    const log = transcriptAccess.listAccessLogForCourse(
      organizationId,
      course.id,
      testDb.db
    )
    expect(log[0]?.personId).toBeNull()
  })

  it('records an export the same way it records a read (ADMIN-3)', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor } =
      seedCourseWithMessages(testDb)

    transcriptAccess.readCourseTranscript(
      organizationId,
      { courseId: course.id, actorAccountId: instructor.id, kind: 'export' },
      testDb.db
    )

    const log = transcriptAccess.listAccessLogForCourse(
      organizationId,
      course.id,
      testDb.db
    )
    expect(log[0]?.kind).toBe('export')
  })

  it('refuses a course belonging to another organization (TEN-5)', () => {
    testDb = createTestDatabase()
    const { course, instructor } = seedCourseWithMessages(testDb)
    const otherOrg = randomUUID()
    organizations.createOrganization(
      otherOrg,
      { name: 'Org B', isPersonal: false },
      testDb.db
    )

    const result = transcriptAccess.readCourseTranscript(
      otherOrg,
      { courseId: course.id, actorAccountId: instructor.id, kind: 'read' },
      testDb.db
    )

    expect(result).toBeUndefined()
    // No audit row either — nothing was actually read.
    expect(
      transcriptAccess.listAccessLogForCourse(otherOrg, course.id, testDb.db)
    ).toHaveLength(0)
  })

  it('refuses a personId belonging to another organization (TEN-5)', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor } =
      seedCourseWithMessages(testDb)
    const otherOrg = randomUUID()
    organizations.createOrganization(
      otherOrg,
      { name: 'Org B', isPersonal: false },
      testDb.db
    )
    const personInOtherOrg = people.createPerson(
      otherOrg,
      { displayName: 'Stranger' },
      testDb.db
    )

    const result = transcriptAccess.readCourseTranscript(
      organizationId,
      {
        courseId: course.id,
        actorAccountId: instructor.id,
        personId: personInOtherOrg.id,
        kind: 'read',
      },
      testDb.db
    )

    expect(result).toBeUndefined()
  })
})

describe('transcriptAccess.listPeopleWithTranscript', () => {
  it('lists every person with at least one message in the course', () => {
    testDb = createTestDatabase()
    const { organizationId, course, alice, bob } =
      seedCourseWithMessages(testDb)

    const listed = transcriptAccess.listPeopleWithTranscript(
      organizationId,
      course.id,
      testDb.db
    )

    expect(listed.map((entry) => entry.personId).sort()).toEqual(
      [alice.id, bob.id].sort()
    )
  })
})
