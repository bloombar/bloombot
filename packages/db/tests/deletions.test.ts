import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  conversations,
  costLedger,
  courseApproval,
  courseAttachments,
  courseInstructionRevisions,
  courseJoinLinks,
  courseWebSources,
  courses,
  deletions,
  enrolments,
  organizations,
  people,
  projects,
  rosterChannelAssignments,
  schema,
  selfEnrolment,
  transcriptAccess,
  transcriptExports,
  usage,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * A course carrying one row in (nearly) every table `deletions.ts#deleteCourse`
 * actually empties — a category and a channel, a conversation with a
 * message, a cost-ledger entry, a course attachment, an instruction
 * revision, an enrolment, a join link, a self-enrolment intent, a web
 * source, a remembered roster channel, and a transcript access-log row plus
 * a pending export, and a COST-8 approval event — so `deleteCourse`
 * (PROJ-8) is exercised against the same shape a real course would leave
 * behind. Synthetic data only (QA-3).
 */
function seedFullCourse(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Full Org', isPersonal: false },
    testDatabase.db
  )
  const organization = { organizationId }
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
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [
        { name: 'General', channels: [{ name: 'chat', adminsOnly: false }] },
      ],
    },
    testDatabase.db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  const course = courseResult.course

  const instructor = accounts.createAccount(
    organizationId,
    {
      email: `instructor-${organizationId}@example.edu`,
      displayName: 'Instructor',
      role: 'owner',
    },
    testDatabase.db
  )

  const student = people.createPerson(
    organizationId,
    { displayName: 'Alice' },
    testDatabase.db
  )

  const conversation = conversations.getOrCreateConversation(
    organizationId,
    { courseId: course.id, personId: student.id, surface: 'web' },
    testDatabase.db
  )
  if (!conversation) throw new Error('seed conversation creation failed')
  conversations.appendMessage(
    organizationId,
    conversation.id,
    { direction: 'from_person', content: 'Hello?' },
    testDatabase.db
  )

  const costLedgerEntry = costLedger.recordCostLedgerEntry(
    organizationId,
    {
      courseId: course.id,
      personId: student.id,
      model: 'gpt-4o-mini',
      inputTokens: 10,
      outputTokens: 10,
      costMicros: 100,
      measurement: 'measured',
      surface: 'discord',
    },
    testDatabase.db
  )
  if (!costLedgerEntry) throw new Error('seed cost ledger entry failed')

  courseAttachments.createPendingAttachment(
    organizationId,
    {
      courseId: course.id,
      filename: 'syllabus.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    },
    testDatabase.db
  )

  courseInstructionRevisions.createRevision(
    organizationId,
    {
      courseId: course.id,
      instructions: 'Be kind.',
      savedByAccountId: instructor.id,
    },
    testDatabase.db
  )

  enrolments.enrolViaRoster(
    organizationId,
    { courseId: course.id, personId: student.id },
    testDatabase.db
  )

  courseJoinLinks.createJoinLink(
    organizationId,
    {
      courseId: course.id,
      secretHash: `hash-${randomUUID()}`,
      createdByAccountId: instructor.id,
    },
    testDatabase.db
  )

  const otherStudent = people.createPerson(
    organizationId,
    { displayName: 'Bob' },
    testDatabase.db
  )
  selfEnrolment.recordSelfEnrolmentIntent(
    organizationId,
    { courseId: course.id, personId: otherStudent.id },
    testDatabase.db
  )

  courseWebSources.addWebSource(
    organizationId,
    { courseId: course.id, domain: 'example.edu' },
    testDatabase.db
  )

  rosterChannelAssignments.recordChannelAssignment(
    organizationId,
    {
      courseId: course.id,
      personId: student.id,
      discordChannelId: `chan-${randomUUID()}`,
    },
    testDatabase.db
  )

  transcriptAccess.readCourseTranscript(
    organizationId,
    { courseId: course.id, actorAccountId: instructor.id, kind: 'read' },
    testDatabase.db
  )

  transcriptExports.createPendingExport(
    organizationId,
    { courseId: course.id, requestedByAccountId: instructor.id },
    testDatabase.db
  )

  // CONV-3 rework finding: `usage_counters` has no `id` column of its own
  // (a composite primary key, `schema.ts`) — the missing row this seed used
  // to leave out was never caught by `.toMatchObject`'s own count
  // assertions below, but would have silently stopped being emptied the
  // moment a future edit deleted the `usage_counters` line from `emptyCourse`
  // (`repos/deletions.ts`) entirely, since nothing here would ever fail.
  usage.incrementUsage(
    organizationId,
    course.id,
    student.id,
    '2026-01-01',
    testDatabase.db
  )

  courseApproval.approveCourse(
    organizationId,
    course.id,
    instructor.id,
    'approve',
    Date.now(),
    testDatabase.db
  )

  return {
    ...organization,
    project,
    course,
    instructor,
    student,
    otherStudent,
    costLedgerEntryId: costLedgerEntry.id,
  }
}

describe('deletions.previewCourseDeletion (PROJ-8)', () => {
  it('counts what will be deleted, before anything is', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedFullCourse(testDb)

    const preview = deletions.previewCourseDeletion(
      organizationId,
      course.id,
      testDb.db
    )

    expect(preview).toMatchObject({
      organizationId,
      courseId: course.id,
      courseTitle: 'Web Design',
      conversations: 1,
      messages: 1,
      enrolments: 1,
      courseAttachments: 1,
    })
    // Nothing was actually touched — still there afterward.
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  it('returns undefined for a course that does not exist, or belongs to another organization', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedFullCourse(testDb)

    expect(
      deletions.previewCourseDeletion(organizationId, randomUUID(), testDb.db)
    ).toBeUndefined()
    expect(
      deletions.previewCourseDeletion(randomUUID(), course.id, testDb.db)
    ).toBeUndefined()
  })
})

describe('deletions.deleteCourse (PROJ-8)', () => {
  it('removes every row that exists only because of the course, including the course itself', () => {
    testDb = createTestDatabase()
    const { organizationId, course, student, instructor } =
      seedFullCourse(testDb)

    const result = deletions.deleteCourse(
      organizationId,
      course.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )
    if (!result) throw new Error('deleteCourse unexpectedly refused')

    expect(result.preview).toMatchObject({
      courseId: course.id,
      conversations: 1,
      messages: 1,
      enrolments: 1,
      courseAttachments: 1,
    })
    // The byte-removal manifest names exactly the attachment and export
    // this course owned, gathered inside the same transaction
    // (`repos/deletions.ts#CourseByteRemoval`'s own doc comment).
    expect(result.byteRemoval.courseId).toBe(course.id)
    expect(result.byteRemoval.attachments).toHaveLength(1)
    expect(result.byteRemoval.exportIds).toHaveLength(1)
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        student.id,
        testDb.db
      )
    ).toBeUndefined()
    expect(
      courseAttachments.listAttachmentsForCourse(
        organizationId,
        course.id,
        testDb.db
      )
    ).toHaveLength(0)
    expect(
      transcriptExports.listExportsForCourse(
        organizationId,
        course.id,
        testDb.db
      )
    ).toHaveLength(0)
    // CONV-3 — `usage_counters` has no `id`/`getUsageCount`-style lookup
    // convenient for a single-row check once the course itself is gone;
    // read raw, the same way the audit-row tests below read `contentDeletions`.
    expect(
      testDb.db
        .select()
        .from(schema.usageCounters)
        .all()
        .filter((row) => row.courseId === course.id)
    ).toHaveLength(0)
    // COST-8 — the approval event `seedFullCourse` recorded is gone too,
    // read raw the same way `usage_counters` above is (no id-keyed lookup
    // convenient for a single-row check once the course itself is deleted).
    expect(
      testDb.db
        .select()
        .from(schema.courseApprovalEvents)
        .all()
        .filter((row) => row.courseId === course.id)
    ).toHaveLength(0)
    // A fresh preview against the same id finds nothing left to count.
    expect(
      deletions.previewCourseDeletion(organizationId, course.id, testDb.db)
    ).toBeUndefined()
  })

  it('survives cost ledger entries with a nulled course id, and leaves the organization’s recorded spend unchanged (PROJ-8)', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor, costLedgerEntryId } =
      seedFullCourse(testDb)

    const spentBefore = costLedger.getOrganizationSpentMicros(
      organizationId,
      testDb.db
    )

    deletions.deleteCourse(
      organizationId,
      course.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )

    const spentAfter = costLedger.getOrganizationSpentMicros(
      organizationId,
      testDb.db
    )
    expect(spentAfter).toBe(spentBefore)
    expect(spentAfter).toBeGreaterThan(0)

    const row = testDb.db
      .select()
      .from(schema.costLedgerEntries)
      .all()
      .find((entry) => entry.id === costLedgerEntryId)
    expect(row?.courseId).toBeNull()
  })

  it('never touches a sibling course in the same project, or another organization’s course', () => {
    testDb = createTestDatabase()
    const { organizationId, course, project, instructor } =
      seedFullCourse(testDb)
    const siblingResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Sibling Course',
        enabled: true,
        adminsRole: 'admins-sib',
        studentsRole: 'students-sib',
        categories: [],
      },
      testDb.db
    )
    if (!siblingResult.ok) throw new Error('seed sibling course failed')
    const { organizationId: otherOrganizationId, course: otherCourse } =
      seedFullCourse(testDb)

    deletions.deleteCourse(
      organizationId,
      course.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )

    expect(
      courses.getCourse(organizationId, siblingResult.course.id, testDb.db)
    ).toBeDefined()
    expect(
      courses.getCourse(otherOrganizationId, otherCourse.id, testDb.db)
    ).toBeDefined()
  })

  it('returns undefined, and deletes nothing, for a course that does not exist', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedFullCourse(testDb)

    const result = deletions.deleteCourse(
      organizationId,
      randomUUID(),
      { deletedByAccountId: randomUUID() },
      testDb.db
    )

    expect(result).toBeUndefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  it('does not record an audit row for a course that does not exist — nothing was deleted', () => {
    testDb = createTestDatabase()
    seedFullCourse(testDb)

    deletions.deleteCourse(
      randomUUID(),
      randomUUID(),
      { deletedByAccountId: randomUUID() },
      testDb.db
    )

    expect(testDb.db.select().from(schema.contentDeletions).all()).toHaveLength(
      0
    )
  })

  it('records who deleted the course, when, and the counts removed (PROJ-8)', () => {
    testDb = createTestDatabase()
    const { organizationId, course, instructor } = seedFullCourse(testDb)

    deletions.deleteCourse(
      organizationId,
      course.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )

    const recorded = testDb.db.select().from(schema.contentDeletions).all()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      organizationId,
      kind: 'course',
      subjectId: course.id,
      subjectName: 'Web Design',
      deletedByAccountId: instructor.id,
    })
    expect(JSON.parse(recorded[0]?.summary ?? '{}')).toMatchObject({
      courseId: course.id,
      conversations: 1,
    })
  })
})

describe('deletions.previewProjectDeletion (PROJ-9)', () => {
  it('totals PROJ-8’s own counts across every course in the project, and names how many courses will go', () => {
    testDb = createTestDatabase()
    const { organizationId, project, course } = seedFullCourse(testDb)
    const secondCourseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Second Course',
        enabled: true,
        adminsRole: 'admins-2nd',
        studentsRole: 'students-2nd',
        categories: [],
      },
      testDb.db
    )
    if (!secondCourseResult.ok) throw new Error('seed second course failed')

    const preview = deletions.previewProjectDeletion(
      organizationId,
      project.id,
      testDb.db
    )

    expect(preview).toMatchObject({
      organizationId,
      projectId: project.id,
      projectName: 'Fall 2026',
      courses: 2,
      conversations: 1,
      messages: 1,
      enrolments: 1,
      courseAttachments: 1,
    })
    // Nothing was actually touched.
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  it('returns undefined for a project that does not exist, or belongs to another organization', () => {
    testDb = createTestDatabase()
    const { organizationId, project } = seedFullCourse(testDb)

    expect(
      deletions.previewProjectDeletion(organizationId, randomUUID(), testDb.db)
    ).toBeUndefined()
    expect(
      deletions.previewProjectDeletion(randomUUID(), project.id, testDb.db)
    ).toBeUndefined()
  })
})

describe('deletions.deleteProject (PROJ-9)', () => {
  it('deletes every course in the project exactly as deleteCourse would, then the project itself, in one transaction', () => {
    testDb = createTestDatabase()
    const { organizationId, project, course, instructor } =
      seedFullCourse(testDb)
    const secondCourseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Second Course',
        enabled: true,
        adminsRole: 'admins-2nd',
        studentsRole: 'students-2nd',
        categories: [],
      },
      testDb.db
    )
    if (!secondCourseResult.ok) throw new Error('seed second course failed')

    const result = deletions.deleteProject(
      organizationId,
      project.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )
    if (!result) throw new Error('deleteProject unexpectedly refused')

    expect(result.preview).toMatchObject({
      projectId: project.id,
      courses: 2,
      conversations: 1,
      messages: 1,
      enrolments: 1,
      courseAttachments: 1,
    })
    // One `CourseByteRemoval` per course this project owned.
    expect(result.byteRemovals).toHaveLength(2)
    expect(
      result.byteRemovals.map((removal) => removal.courseId).sort()
    ).toEqual([course.id, secondCourseResult.course.id].sort())
    expect(
      projects.getProject(organizationId, project.id, testDb.db)
    ).toBeUndefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
    expect(
      courses.getCourse(organizationId, secondCourseResult.course.id, testDb.db)
    ).toBeUndefined()
    expect(
      deletions.previewProjectDeletion(organizationId, project.id, testDb.db)
    ).toBeUndefined()
  })

  it('deletes an archived project exactly as readily as a live one', () => {
    testDb = createTestDatabase()
    const { organizationId, project, instructor } = seedFullCourse(testDb)
    projects.archiveProject(organizationId, project.id, testDb.db)

    const result = deletions.deleteProject(
      organizationId,
      project.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )

    expect(result?.preview).toMatchObject({ projectId: project.id, courses: 1 })
    expect(
      projects.getProject(organizationId, project.id, testDb.db)
    ).toBeUndefined()
  })

  it('survives cost ledger entries with a nulled course id, the same as deleteCourse', () => {
    testDb = createTestDatabase()
    const { organizationId, project, instructor, costLedgerEntryId } =
      seedFullCourse(testDb)

    deletions.deleteProject(
      organizationId,
      project.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )

    const row = testDb.db
      .select()
      .from(schema.costLedgerEntries)
      .all()
      .find((entry) => entry.id === costLedgerEntryId)
    expect(row).toBeDefined()
    expect(row?.courseId).toBeNull()
  })

  it('never touches another project, or another organization’s project', () => {
    testDb = createTestDatabase()
    const { organizationId, project, instructor } = seedFullCourse(testDb)
    const survivingProject = projects.createProject(
      organizationId,
      { name: 'Spring 2027' },
      testDb.db
    )
    const { organizationId: otherOrganizationId, project: otherProject } =
      seedFullCourse(testDb)

    deletions.deleteProject(
      organizationId,
      project.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )

    expect(
      projects.getProject(organizationId, survivingProject.id, testDb.db)
    ).toBeDefined()
    expect(
      projects.getProject(otherOrganizationId, otherProject.id, testDb.db)
    ).toBeDefined()
  })

  it('returns undefined, and deletes nothing, for a project that does not exist', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedFullCourse(testDb)

    const result = deletions.deleteProject(
      organizationId,
      randomUUID(),
      { deletedByAccountId: randomUUID() },
      testDb.db
    )

    expect(result).toBeUndefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
  })

  it('records who deleted the project, when, and the counts removed (PROJ-9)', () => {
    testDb = createTestDatabase()
    const { organizationId, project, instructor } = seedFullCourse(testDb)

    deletions.deleteProject(
      organizationId,
      project.id,
      { deletedByAccountId: instructor.id },
      testDb.db
    )

    const recorded = testDb.db.select().from(schema.contentDeletions).all()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      organizationId,
      kind: 'project',
      subjectId: project.id,
      subjectName: 'Fall 2026',
      deletedByAccountId: instructor.id,
    })
  })
})
