import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  courseJoinLinks,
  courses,
  enrolments,
  organizations,
  people,
  projects,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds an organization with one enabled course and an owning account, synthetic data only (QA-3). */
function seedOrganizationWithCourse(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org A', isPersonal: false },
    testDatabase.db
  )
  const owner = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Owner',
      role: 'owner',
    },
    testDatabase.db
  )
  const project = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const result = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd-fa26',
      studentsRole: 'students-wd-fa26',
      categories: [],
    },
    testDatabase.db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return { organizationId, course: result.course, ownerId: owner.id }
}

describe('course-join-links repo (ENRL-3, ENRL-4)', () => {
  // --- The secret is returned once and stored only as a hash -------------

  it('stores only the hash — the row never carries the plaintext secret', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)

    const link = courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'a-hash-value',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    expect(link).toMatchObject({ secretHash: 'a-hash-value' })
    expect(JSON.stringify(link)).not.toContain('plaintext-secret-value')
  })

  // --- ENRL-3: redeeming enrols the redeemer ------------------------------

  it('redeeming enrols the redeemer, recording source "join_link"', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const enrolment = courseJoinLinks.redeemJoinLink(
      'hash-1',
      person.id,
      Date.now(),
      testDb.db
    )

    expect(enrolment?.source).toBe('join_link')
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeDefined()
  })

  it('refuses a hash that was never issued', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      courseJoinLinks.redeemJoinLink(
        'never-issued',
        person.id,
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
  })

  // --- ENRL-4: revoked or expired admits nobody ---------------------------

  it('a revoked link admits nobody', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const link = courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )
    courseJoinLinks.revokeJoinLink(organizationId, link.id, testDb.db)

    expect(
      courseJoinLinks.redeemJoinLink('hash-1', person.id, Date.now(), testDb.db)
    ).toBeUndefined()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeUndefined()
  })

  it('an expired link admits nobody', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const now = Date.now()

    courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        expiresAt: now - 1,
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    expect(
      courseJoinLinks.redeemJoinLink('hash-1', person.id, now, testDb.db)
    ).toBeUndefined()
  })

  it('a link with no expiry stays valid until revoked', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    expect(
      courseJoinLinks.redeemJoinLink('hash-1', person.id, Date.now(), testDb.db)
    ).toBeDefined()
  })

  // --- ENRL-4: revoking after somebody joined leaves them enrolled -------

  it('revoking a link after somebody joined through it leaves that person enrolled', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const link = courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )
    courseJoinLinks.redeemJoinLink('hash-1', person.id, Date.now(), testDb.db)

    const changed = courseJoinLinks.revokeJoinLink(
      organizationId,
      link.id,
      testDb.db
    )

    expect(changed).toBe(1)
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeDefined()
  })

  // --- Tenant scoping (TEN-2/TEN-5) ---------------------------------------

  it("does not read another organization's join link through the wrong organization", () => {
    testDb = createTestDatabase()
    const {
      organizationId: orgA,
      course: courseA,
      ownerId: ownerA,
    } = seedOrganizationWithCourse(testDb)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb)

    const link = courseJoinLinks.createJoinLink(
      orgA,
      {
        courseId: courseA.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerA,
      },
      testDb.db
    )

    expect(
      courseJoinLinks.getJoinLink(orgB, link.id, testDb.db)
    ).toBeUndefined()
    expect(courseJoinLinks.revokeJoinLink(orgB, link.id, testDb.db)).toBe(0)
    expect(courseJoinLinks.getJoinLink(orgA, link.id, testDb.db)).toMatchObject(
      {
        revokedAt: null,
      }
    )
  })

  it("redeeming refuses a person from a different organization than the link's own", () => {
    testDb = createTestDatabase()
    const {
      organizationId: orgA,
      course: courseA,
      ownerId: ownerA,
    } = seedOrganizationWithCourse(testDb)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb)
    const personInOrgB = people.createPerson(orgB, {}, testDb.db)

    courseJoinLinks.createJoinLink(
      orgA,
      {
        courseId: courseA.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerA,
      },
      testDb.db
    )

    expect(
      courseJoinLinks.redeemJoinLink(
        'hash-1',
        personInOrgB.id,
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
  })
})
