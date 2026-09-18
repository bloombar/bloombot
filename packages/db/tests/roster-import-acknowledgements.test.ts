/**
 * Repository for `roster_import_acknowledgements` (ROST-20). Every
 * atomicity claim here is checked against the real, throwaway database
 * `createTestDatabase` opens under `tmp/`, the same discipline `jobs.test.ts`
 * already holds itself to.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  jobs,
  organizations,
  projects,
  courses,
  rosterImportAcknowledgements,
  writeTransaction,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization, one course, one instructor account, and the `roster.import` job the acknowledgement it seeds accompanies. */
function seedOrganizationWithCourseAndJob(
  testDatabase: TestDatabase,
  organizationName = 'Org'
) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: organizationName, isPersonal: false },
    testDatabase.db
  )
  const account = accounts.createAccount(
    organizationId,
    {
      email: `instructor-${randomUUID()}@example.edu`,
      displayName: 'Instructor',
      role: 'instructor',
    },
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
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  const job = jobs.enqueueJob(
    organizationId,
    { kind: 'roster.import', payload: {}, maxAttempts: 5 },
    testDatabase.db
  )
  return { organizationId, course: courseResult.course, account, job }
}

describe('rosterImportAcknowledgements.recordAcknowledgement (ROST-20)', () => {
  it('records an entry scoped to its organization', () => {
    testDb = createTestDatabase()
    const { organizationId, course, account, job } =
      seedOrganizationWithCourseAndJob(testDb)

    const entry = rosterImportAcknowledgements.recordAcknowledgement(
      organizationId,
      {
        courseId: course.id,
        accountId: account.id,
        filename: 'roster.csv',
        jobId: job.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: 1000,
      },
      testDb.db
    )

    expect(entry).toMatchObject({
      organizationId,
      courseId: course.id,
      accountId: account.id,
      filename: 'roster.csv',
      jobId: job.id,
      acknowledgementVersion: '2026-09-18',
      acknowledgedAt: 1000,
    })
  })

  it("can be written in the same transaction as the job it accompanies — proving `enqueueJob`'s own widened `Executor` parameter", () => {
    testDb = createTestDatabase()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Org', isPersonal: false },
      testDb.db
    )
    const account = accounts.createAccount(
      organizationId,
      { email: 'i@example.edu', displayName: 'Instructor', role: 'instructor' },
      testDb.db
    )
    const project = projects.createProject(
      organizationId,
      { name: 'Fall 2026' },
      testDb.db
    )
    const courseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Web Design',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!courseResult.ok) throw new Error('seed course creation failed')

    const { jobId, acknowledgementId } = writeTransaction(testDb.db, (tx) => {
      const job = jobs.enqueueJob(
        organizationId,
        { kind: 'roster.import', payload: {}, maxAttempts: 5 },
        tx
      )
      const entry = rosterImportAcknowledgements.recordAcknowledgement(
        organizationId,
        {
          courseId: courseResult.course.id,
          accountId: account.id,
          filename: 'roster.csv',
          jobId: job.id,
          acknowledgementVersion: '2026-09-18',
          acknowledgedAt: 2000,
        },
        tx
      )
      return { jobId: job.id, acknowledgementId: entry.id }
    })

    const acknowledgements =
      rosterImportAcknowledgements.listAcknowledgementsForCourse(
        organizationId,
        courseResult.course.id,
        testDb.db
      )
    expect(acknowledgements).toHaveLength(1)
    expect(acknowledgements[0]).toMatchObject({
      id: acknowledgementId,
      jobId,
    })
  })
})

describe('rosterImportAcknowledgements.listAcknowledgementsForCourse (ROST-20)', () => {
  it('reads back entries scoped to the organization, newest first', () => {
    testDb = createTestDatabase()
    const { organizationId, course, account, job } =
      seedOrganizationWithCourseAndJob(testDb)
    rosterImportAcknowledgements.recordAcknowledgement(
      organizationId,
      {
        courseId: course.id,
        accountId: account.id,
        filename: 'first.csv',
        jobId: job.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: 1000,
      },
      testDb.db
    )
    const secondJob = jobs.enqueueJob(
      organizationId,
      { kind: 'roster.import', payload: {}, maxAttempts: 5 },
      testDb.db
    )
    rosterImportAcknowledgements.recordAcknowledgement(
      organizationId,
      {
        courseId: course.id,
        accountId: account.id,
        filename: 'second.csv',
        jobId: secondJob.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: 2000,
      },
      testDb.db
    )

    const entries = rosterImportAcknowledgements.listAcknowledgementsForCourse(
      organizationId,
      course.id,
      testDb.db
    )

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ filename: 'second.csv' })
    expect(entries[1]).toMatchObject({ filename: 'first.csv' })
  })

  it('is empty for another organization’s course (TEN-5)', () => {
    testDb = createTestDatabase()
    const { course, account, job } = seedOrganizationWithCourseAndJob(testDb)
    const otherOrganizationId = randomUUID()
    organizations.createOrganization(
      otherOrganizationId,
      { name: 'Other Org', isPersonal: false },
      testDb.db
    )

    rosterImportAcknowledgements.recordAcknowledgement(
      // The real organization owns the course; the point is the *read*
      // below is scoped, not this write.
      course.organizationId,
      {
        courseId: course.id,
        accountId: account.id,
        filename: 'roster.csv',
        jobId: job.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: 1000,
      },
      testDb.db
    )

    expect(
      rosterImportAcknowledgements.listAcknowledgementsForCourse(
        otherOrganizationId,
        course.id,
        testDb.db
      )
    ).toEqual([])
  })
})

describe('rosterImportAcknowledgements.listAcknowledgementsForAccount (ROST-20/ADMIN-11)', () => {
  it('lists every acknowledgement an account has made, across organizations, with course and organization names', () => {
    testDb = createTestDatabase()
    const first = seedOrganizationWithCourseAndJob(testDb, 'Org One')
    const secondOrganizationId = randomUUID()
    organizations.createOrganization(
      secondOrganizationId,
      { name: 'Org Two', isPersonal: false },
      testDb.db
    )
    const secondProject = projects.createProject(
      secondOrganizationId,
      { name: 'Spring 2027' },
      testDb.db
    )
    const secondCourseResult = courses.createCourse(
      secondOrganizationId,
      {
        projectId: secondProject.id,
        title: 'Data Structures',
        enabled: true,
        adminsRole: 'admins-ds',
        studentsRole: 'students-ds',
        categories: [],
      },
      testDb.db
    )
    if (!secondCourseResult.ok) throw new Error('seed course creation failed')
    const secondJob = jobs.enqueueJob(
      secondOrganizationId,
      { kind: 'roster.import', payload: {}, maxAttempts: 5 },
      testDb.db
    )
    // The same account acknowledges an import in a second organization —
    // proves this reads across organizations rather than being scoped to
    // one, the whole point of the TEN-2 exception. `accounts.id` is the
    // only thing `rosterImportAcknowledgements.accountId` references
    // (`schema.ts`) — no second membership row is needed for this.
    rosterImportAcknowledgements.recordAcknowledgement(
      first.organizationId,
      {
        courseId: first.course.id,
        accountId: first.account.id,
        filename: 'roster-one.csv',
        jobId: first.job.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: 1000,
      },
      testDb.db
    )
    rosterImportAcknowledgements.recordAcknowledgement(
      secondOrganizationId,
      {
        courseId: secondCourseResult.course.id,
        accountId: first.account.id,
        filename: 'roster-two.csv',
        jobId: secondJob.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: 2000,
      },
      testDb.db
    )

    const entries = rosterImportAcknowledgements.listAcknowledgementsForAccount(
      first.account.id,
      testDb.db
    )

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      filename: 'roster-two.csv',
      courseTitle: 'Data Structures',
      organizationName: 'Org Two',
    })
    expect(entries[1]).toMatchObject({
      filename: 'roster-one.csv',
      courseTitle: 'Web Design',
      organizationName: 'Org One',
    })
  })

  it('is empty for an account that has never acknowledged an import', () => {
    testDb = createTestDatabase()
    const { account } = seedOrganizationWithCourseAndJob(testDb)

    expect(
      rosterImportAcknowledgements.listAcknowledgementsForAccount(
        account.id,
        testDb.db
      )
    ).toEqual([])
  })
})
