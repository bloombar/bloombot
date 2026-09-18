import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  courseApproval,
  courses,
  organizations,
  projects,
  schema,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * One organization, one project, one pending course, synthetic data only
 * (QA-3). `ownerEmail` defaults to a fixed address — every existing caller
 * in this file only ever seeds one organization per test, so the default
 * never collides; `accounts.email` is globally unique (`schema.ts`), so a
 * test that seeds *two* organizations in the same run (ADMIN-6's own
 * `findCourseOrganizationId` suite, below) has to supply a distinct one for
 * the second call.
 */
function seedOrganizationWithCourse(
  testDatabase: TestDatabase,
  ownerEmail = 'owner@example.edu'
) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org', isPersonal: false },
    testDatabase.db
  )
  const owner = accounts.createAccount(
    organizationId,
    { email: ownerEmail, displayName: 'Owner', role: 'owner' },
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
  return { organizationId, project, course: courseResult.course, owner }
}

describe('courseApproval.approveCourse (COST-8)', () => {
  it('approves a pending course, recording who and when', () => {
    testDb = createTestDatabase()
    const { organizationId, course, owner } = seedOrganizationWithCourse(testDb)
    const now = Date.now()

    const approved = courseApproval.approveCourse(
      organizationId,
      course.id,
      owner.id,
      'approve',
      now,
      testDb.db
    )

    expect(approved).toMatchObject({
      id: course.id,
      aiApprovedAt: now,
      aiApprovedByAccountId: owner.id,
      aiApprovalDecidedAt: now,
    })
  })

  it('records accountId null for an automatic approval', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const now = Date.now()

    const approved = courseApproval.approveCourse(
      organizationId,
      course.id,
      null,
      'auto-approve',
      now,
      testDb.db
    )

    expect(approved?.aiApprovedByAccountId).toBeNull()
  })

  it('writes an approval event with the given action and account', () => {
    testDb = createTestDatabase()
    const { organizationId, course, owner } = seedOrganizationWithCourse(testDb)
    const now = Date.now()

    courseApproval.approveCourse(
      organizationId,
      course.id,
      owner.id,
      'approve',
      now,
      testDb.db
    )

    // Read raw — this file has no `listEvents` of its own (only
    // `listCoursesForApproval` reads across courses, and it does not
    // surface individual events), the same "read raw for a test-only
    // assertion" shape `deletions.test.ts` already uses for
    // `usage_counters`.
    const events = testDb.db
      .select()
      .from(schema.courseApprovalEvents)
      .all()
      .filter((row) => row.courseId === course.id)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      organizationId,
      courseId: course.id,
      action: 'approve',
      accountId: owner.id,
      createdAt: now,
    })
  })

  it('is a no-op, not an error, for an already-approved course — and writes no second event', () => {
    testDb = createTestDatabase()
    const { organizationId, course, owner } = seedOrganizationWithCourse(testDb)
    const first = courseApproval.approveCourse(
      organizationId,
      course.id,
      owner.id,
      'approve',
      1000,
      testDb.db
    )

    const second = courseApproval.approveCourse(
      organizationId,
      course.id,
      null,
      'auto-approve',
      2000,
      testDb.db
    )

    // Untouched — the second call's own `now`/`action`/`accountId` never
    // landed, because the course was already approved.
    expect(second).toMatchObject({
      aiApprovedAt: first?.aiApprovedAt,
      aiApprovedByAccountId: first?.aiApprovedByAccountId,
      aiApprovalDecidedAt: first?.aiApprovalDecidedAt,
    })
  })

  it('returns undefined for a course that does not exist, or belongs to another organization', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)

    expect(
      courseApproval.approveCourse(
        organizationId,
        randomUUID(),
        null,
        'auto-approve',
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
    expect(
      courseApproval.approveCourse(
        randomUUID(),
        course.id,
        null,
        'auto-approve',
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
  })
})

describe('courseApproval.revokeCourseApproval (COST-8)', () => {
  it('clears the approval, but still sets aiApprovalDecidedAt (so lazy auto-approval never re-approves it)', () => {
    testDb = createTestDatabase()
    const { organizationId, course, owner } = seedOrganizationWithCourse(testDb)
    courseApproval.approveCourse(
      organizationId,
      course.id,
      owner.id,
      'approve',
      1000,
      testDb.db
    )

    const revoked = courseApproval.revokeCourseApproval(
      organizationId,
      course.id,
      owner.id,
      2000,
      testDb.db
    )

    expect(revoked).toMatchObject({
      aiApprovedAt: null,
      aiApprovedByAccountId: null,
      aiApprovalDecidedAt: 2000,
    })
  })

  it('writes a revoke event, naming the deciding account', () => {
    testDb = createTestDatabase()
    const { organizationId, course, owner } = seedOrganizationWithCourse(testDb)
    courseApproval.approveCourse(
      organizationId,
      course.id,
      owner.id,
      'approve',
      1000,
      testDb.db
    )

    courseApproval.revokeCourseApproval(
      organizationId,
      course.id,
      owner.id,
      2000,
      testDb.db
    )

    const events = testDb.db
      .select()
      .from(schema.courseApprovalEvents)
      .all()
      .filter((row) => row.courseId === course.id)
      .sort((a, b) => a.createdAt - b.createdAt)

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      action: 'revoke',
      accountId: owner.id,
      createdAt: 2000,
    })
  })

  it('returns undefined for a course that does not exist, or belongs to another organization', () => {
    testDb = createTestDatabase()
    const { organizationId, course, owner } = seedOrganizationWithCourse(testDb)

    expect(
      courseApproval.revokeCourseApproval(
        organizationId,
        randomUUID(),
        owner.id,
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
    expect(
      courseApproval.revokeCourseApproval(
        randomUUID(),
        course.id,
        owner.id,
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
  })
})

describe('courseApproval.isAdministratorOwnedOrganization (COST-8)', () => {
  it('is true when a non-disabled owner’s email passes the supplied predicate', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganizationWithCourse(testDb)

    expect(
      courseApproval.isAdministratorOwnedOrganization(
        organizationId,
        (email) => email === owner.email,
        testDb.db
      )
    ).toBe(true)
  })

  it('is false when no owner’s email passes the predicate', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithCourse(testDb)

    expect(
      courseApproval.isAdministratorOwnedOrganization(
        organizationId,
        () => false,
        testDb.db
      )
    ).toBe(false)
  })

  it('ignores a disabled owner account, even if its email would otherwise pass', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganizationWithCourse(testDb)
    accounts.disableAccount(owner.id, testDb.db)

    expect(
      courseApproval.isAdministratorOwnedOrganization(
        organizationId,
        (email) => email === owner.email,
        testDb.db
      )
    ).toBe(false)
  })

  it('ignores a non-owner membership, even from an administrator email', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithCourse(testDb)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'admin@example.edu', displayName: 'Admin', role: 'instructor' },
      testDb.db
    )

    expect(
      courseApproval.isAdministratorOwnedOrganization(
        organizationId,
        (email) => email === instructor.email,
        testDb.db
      )
    ).toBe(false)
  })
})

describe('courseApproval.listCoursesForApproval (COST-8/WEB-53)', () => {
  it('lists pending and approved courses across every organization, with owner ids and emails (ADMIN-12)', () => {
    testDb = createTestDatabase()
    const { organizationId, project, course, owner } =
      seedOrganizationWithCourse(testDb)
    // A second owner on the same organization — proves the batched lookup
    // (`listCoursesForApproval`'s own comment on "one query, not one per
    // course") still returns every owner, not merely the first.
    const secondOwner = accounts.createAccount(
      organizationId,
      { email: 'co-owner@example.edu', displayName: 'Co-Owner', role: 'owner' },
      testDb.db
    )
    courseApproval.approveCourse(
      organizationId,
      course.id,
      owner.id,
      'approve',
      Date.now(),
      testDb.db
    )

    const otherOrg = randomUUID()
    organizations.createOrganization(
      otherOrg,
      { name: 'Other Org', isPersonal: false },
      testDb.db
    )
    const otherProject = projects.createProject(
      otherOrg,
      { name: 'Spring 2027' },
      testDb.db
    )
    const pendingCourseResult = courses.createCourse(
      otherOrg,
      {
        projectId: otherProject.id,
        title: 'Pending Course',
        enabled: true,
        adminsRole: 'admins-pc',
        studentsRole: 'students-pc',
        categories: [],
      },
      testDb.db
    )
    if (!pendingCourseResult.ok) throw new Error('seed course failed')

    const rows = courseApproval.listCoursesForApproval(testDb.db)

    const approvedRow = rows.find((row) => row.courseId === course.id)
    const pendingRow = rows.find(
      (row) => row.courseId === pendingCourseResult.course.id
    )
    expect(approvedRow).toMatchObject({
      courseTitle: 'Web Design',
      projectId: project.id,
      projectName: 'Fall 2026',
      organizationName: 'Org',
      // WEB-53's "who acted" — the deliberate `'approve'` above names the
      // owner both by id and by email.
      aiApprovedByAccountId: owner.id,
      aiApprovedByEmail: 'owner@example.edu',
    })
    expect(approvedRow?.owners).toEqual(
      expect.arrayContaining([
        { accountId: owner.id, email: 'owner@example.edu' },
        { accountId: secondOwner.id, email: 'co-owner@example.edu' },
      ])
    )
    expect(approvedRow?.owners).toHaveLength(2)
    expect(approvedRow?.aiApprovedAt).not.toBeNull()
    expect(pendingRow).toMatchObject({
      courseTitle: 'Pending Course',
      projectId: otherProject.id,
      projectName: 'Spring 2027',
      organizationName: 'Other Org',
      // `otherOrg` has no owner account seeded — a course with no owners.
      owners: [],
      aiApprovedByAccountId: null,
      aiApprovedByEmail: null,
    })
    expect(pendingRow?.aiApprovedAt).toBeNull()
  })

  it("leaves the approver email null for an auto-approved course — this file’s own module comment on `accountId` being null for `'auto-approve'`", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    courseApproval.approveCourse(
      organizationId,
      course.id,
      null,
      'auto-approve',
      Date.now(),
      testDb.db
    )

    const row = courseApproval
      .listCoursesForApproval(testDb.db)
      .find((candidate) => candidate.courseId === course.id)

    expect(row?.aiApprovedAt).not.toBeNull()
    expect(row?.aiApprovedByAccountId).toBeNull()
    expect(row?.aiApprovedByEmail).toBeNull()
  })
})

describe('courseApproval.listApprovalEventsForCourse (WEB-53)', () => {
  it('lists a course’s approve/revoke history, newest first', () => {
    testDb = createTestDatabase()
    const { organizationId, course, owner } = seedOrganizationWithCourse(testDb)
    courseApproval.approveCourse(
      organizationId,
      course.id,
      owner.id,
      'approve',
      1000,
      testDb.db
    )
    courseApproval.revokeCourseApproval(
      organizationId,
      course.id,
      owner.id,
      2000,
      testDb.db
    )

    const events = courseApproval.listApprovalEventsForCourse(
      organizationId,
      course.id,
      testDb.db
    )

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ action: 'revoke', createdAt: 2000 })
    expect(events[1]).toMatchObject({ action: 'approve', createdAt: 1000 })
  })

  it('is empty for a course with no decisions yet, and scoped by organization', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)

    expect(
      courseApproval.listApprovalEventsForCourse(
        organizationId,
        course.id,
        testDb.db
      )
    ).toEqual([])
    expect(
      courseApproval.listApprovalEventsForCourse(
        randomUUID(),
        course.id,
        testDb.db
      )
    ).toEqual([])
  })
})

describe('courseApproval.findCourseOrganizationId (ADMIN-6, second review round)', () => {
  it('resolves an existing course id to its own organization id', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)

    expect(courseApproval.findCourseOrganizationId(course.id, testDb.db)).toBe(
      organizationId
    )
  })

  it('is undefined for a course id that does not exist', () => {
    testDb = createTestDatabase()

    expect(
      courseApproval.findCourseOrganizationId(randomUUID(), testDb.db)
    ).toBeUndefined()
  })

  it('is a scoped point lookup, not the listCoursesForApproval scan — resolves correctly across several organizations', () => {
    testDb = createTestDatabase()
    const first = seedOrganizationWithCourse(testDb)
    const second = seedOrganizationWithCourse(testDb, 'owner-2@example.edu')

    expect(
      courseApproval.findCourseOrganizationId(first.course.id, testDb.db)
    ).toBe(first.organizationId)
    expect(
      courseApproval.findCourseOrganizationId(second.course.id, testDb.db)
    ).toBe(second.organizationId)
  })
})
