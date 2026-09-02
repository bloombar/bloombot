import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  conversations,
  costLedger,
  courseAttachments,
  courses,
  discordServers,
  enrolments,
  jobs,
  memberships,
  organizations,
  people,
  projects,
  transcriptAccess,
  transcriptExports,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * A reasonably full tenant: a project, a course, an instructor account, two
 * students (one merged into the other), a conversation with a message, a
 * cost-ledger entry, a course attachment row, an enrolment, a Discord server
 * binding, a queued job, a transcript-access-log row and a transcript
 * export row — one row in (nearly) every organization-scoped table, so
 * `deleteOrganizationData` (ADMIN-5) is exercised against the same shape a
 * real tenant would leave behind, not just the tables a narrower test
 * happens to touch. Synthetic data only (QA-3).
 */
function seedFullTenant(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Full Org', isPersonal: false },
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
      email: `instructor-${organizationId}@example.edu`,
      displayName: 'Instructor',
      role: 'owner',
    },
    testDatabase.db
  )

  const survivor = people.createPerson(
    organizationId,
    { displayName: 'Alice' },
    testDatabase.db
  )
  const loser = people.createPerson(
    organizationId,
    { displayName: 'Alice (Discord)' },
    testDatabase.db
  )
  // Exercises the self-referencing `mergedIntoPersonId` column this
  // function's own doc comment says it has to null out before deleting.
  people.mergePeople(organizationId, survivor.id, loser.id, testDatabase.db)

  const conversation = conversations.getOrCreateConversation(
    organizationId,
    { courseId: course.id, personId: survivor.id, surface: 'web' },
    testDatabase.db
  )
  if (!conversation) throw new Error('seed conversation creation failed')
  conversations.appendMessage(
    organizationId,
    conversation.id,
    { direction: 'from_person', content: 'Hello?' },
    testDatabase.db
  )

  costLedger.recordCostLedgerEntry(
    organizationId,
    {
      courseId: course.id,
      personId: survivor.id,
      model: 'gpt-4o-mini',
      inputTokens: 10,
      outputTokens: 10,
      costMicros: 100,
      measurement: 'measured',
    },
    testDatabase.db
  )

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

  enrolments.enrolViaRoster(
    organizationId,
    { courseId: course.id, personId: survivor.id },
    testDatabase.db
  )

  discordServers.claimDiscordServerBinding(
    organizationId,
    { serverId: randomUUID(), installedByAccountId: instructor.id },
    testDatabase.db
  )

  jobs.enqueueJob(
    organizationId,
    { kind: 'transcripts.export', payload: {}, maxAttempts: 3 },
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

  return { organizationId, course, instructor, survivor, loser }
}

describe('organizations.previewOrganizationDeletion (ADMIN-5)', () => {
  it('counts what will be deleted, before anything is', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedFullTenant(testDb)

    const preview = organizations.previewOrganizationDeletion(
      organizationId,
      testDb.db
    )

    expect(preview).toMatchObject({
      organizationId,
      organizationName: 'Full Org',
      courses: 1,
      people: 2,
      conversations: 1,
      messages: 1,
      enrolments: 1,
      discordServerBindings: 1,
      courseAttachments: 1,
      queuedJobs: 1,
    })
    // Nothing was actually touched — still there afterward.
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
  })

  it('returns undefined for an organization that does not exist', () => {
    testDb = createTestDatabase()
    expect(
      organizations.previewOrganizationDeletion(randomUUID(), testDb.db)
    ).toBeUndefined()
  })
})

describe('organizations.deleteOrganizationData (ADMIN-5)', () => {
  it('removes every row this tenant owns, including the organization itself', () => {
    testDb = createTestDatabase()
    const { organizationId, course, survivor } = seedFullTenant(testDb)

    const result = organizations.deleteOrganizationData(
      organizationId,
      testDb.db
    )

    expect(result).toMatchObject({ organizationId, courses: 1, people: 2 })
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeUndefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
    expect(
      people.getPerson(organizationId, survivor.id, testDb.db)
    ).toBeUndefined()
    // Confirms the whole tenant is actually gone, not merely the rows this
    // test happened to name — a fresh preview against the same id finds
    // nothing left to count.
    expect(
      organizations.previewOrganizationDeletion(organizationId, testDb.db)
    ).toBeUndefined()
  })

  it('does not delete the account — an account is not scoped to one organization (TEN-1)', () => {
    testDb = createTestDatabase()
    const { organizationId, instructor } = seedFullTenant(testDb)

    organizations.deleteOrganizationData(organizationId, testDb.db)

    expect(accounts.getAccountById(instructor.id, testDb.db)).toBeDefined()
    // The membership itself — the join between the two — is gone.
    expect(
      memberships.getMembership(organizationId, instructor.id, testDb.db)
    ).toBeUndefined()
  })

  it('never touches a second organization’s data (cross-tenant isolation of the delete itself)', () => {
    testDb = createTestDatabase()
    const { organizationId: deletedOrg } = seedFullTenant(testDb)
    const { organizationId: survivingOrg, course: survivingCourse } =
      seedFullTenant(testDb)

    organizations.deleteOrganizationData(deletedOrg, testDb.db)

    expect(
      organizations.getOrganizationById(survivingOrg, testDb.db)
    ).toBeDefined()
    expect(
      courses.getCourse(survivingOrg, survivingCourse.id, testDb.db)
    ).toBeDefined()
  })

  it('returns undefined, and deletes nothing, for an organization that does not exist', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedFullTenant(testDb)

    const result = organizations.deleteOrganizationData(randomUUID(), testDb.db)

    expect(result).toBeUndefined()
    // The real organization this test seeded is untouched.
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
  })
})

describe('organizations.recordTenantDeletion / listTenantDeletions (ADMIN-5)', () => {
  it('records who deleted which organization, and when — and outlives the organization it describes', () => {
    testDb = createTestDatabase()
    const { organizationId, instructor } = seedFullTenant(testDb)
    const preview = organizations.previewOrganizationDeletion(
      organizationId,
      testDb.db
    )
    organizations.deleteOrganizationData(organizationId, testDb.db)

    const recorded = organizations.recordTenantDeletion(
      organizationId,
      {
        organizationName: 'Full Org',
        deletedByAccountId: instructor.id,
        summary: preview,
      },
      testDb.db
    )

    expect(recorded).toMatchObject({
      organizationId,
      organizationName: 'Full Org',
      deletedByAccountId: instructor.id,
    })

    const listed = organizations.listTenantDeletions(testDb.db)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.organizationId).toBe(organizationId)
    expect(JSON.parse(listed[0]?.summary ?? '{}')).toMatchObject({
      courses: 1,
    })
  })
})
