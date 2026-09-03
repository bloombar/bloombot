import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  accounts,
  closeDatabase,
  courseJoinLinks,
  courses,
  enrolments,
  openDatabase,
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

    // Cheap-fix 8: this repo never sees a plaintext secret at all — it is
    // handed `secretHash` and stores exactly that — so the assertion that
    // matters here is that the stored row holds the hash it was given,
    // verbatim; whether a *caller* hashed correctly is
    // `packages/actions/tests/course-join-links.test.ts`'s own concern (that
    // layer is where a real secret exists to hash in the first place).
    expect(link).toMatchObject({ secretHash: 'a-hash-value' })
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

  // --- Rework finding 6: redemption is atomic -----------------------------

  // Fails without the fix: before `redeemJoinLink` wrapped its three
  // statements in one `db.transaction(...)`, a concurrent revoke that
  // committed after this function's own "is the link still live" read, but
  // before its enrolment write, still let the already-in-flight redemption
  // complete — `courseJoinLinks.revoke` could report success while one more
  // person joined anyway.
  it('redemption is atomic: a revoke racing with an in-flight redemption cannot let one more person join', () => {
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

    // A second connection to the very same file — standing in for a
    // different process (`apps/api`, revoking this link) racing against
    // another (`apps/bot`/`apps/web`) mid-redemption of it.
    const secondConnection = openDatabase(testDb.path)
    const realGetPerson = people.getPerson
    const spy = vi
      .spyOn(people, 'getPerson')
      .mockImplementationOnce((...args) => {
        // Fires from inside `redeemJoinLink`'s own transaction, after its
        // link-liveness read and before its enrolment write — exactly the
        // race window an un-transacted redemption left open.
        courseJoinLinks.revokeJoinLink(
          organizationId,
          link.id,
          secondConnection
        )
        return realGetPerson(...args)
      })

    try {
      courseJoinLinks.redeemJoinLink('hash-1', person.id, Date.now(), testDb.db)
    } catch {
      // Either outcome — a thrown write-conflict, or a clean `undefined` —
      // is acceptable here; what this test actually pins down is the
      // assertion below, which holds either way.
    } finally {
      spy.mockRestore()
      closeDatabase(secondConnection)
    }

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeUndefined()
    expect(
      courseJoinLinks.getJoinLink(organizationId, link.id, testDb.db)
    ).toMatchObject({ revokedAt: expect.any(Number) })
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

  // --- WEB-20: listing a course's join links -----------------------------

  // The clock is frozen and stepped by hand (the same device
  // `conversations.test.ts`'s own "orders a transcript by append order even
  // when every message shares the same millisecond" uses) — `createdAt`
  // alone ties for two rows minted in the same real millisecond, which a
  // fast test run hits often enough to make this test flaky without control
  // of the clock. `course_join_links` carries no `sequence` column the way
  // `course_instruction_revisions`/`messages` do (a migration this brief's
  // own scope excludes), so this list's ordering guarantee is only ever as
  // fine-grained as `createdAt` itself — proven here with distinct
  // millisecond values, not a same-millisecond tie this function does not
  // claim to break any particular way.
  it('lists a course own join links, newest first', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)

    vi.useFakeTimers()
    let first: courseJoinLinks.CourseJoinLink
    let second: courseJoinLinks.CourseJoinLink
    try {
      vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'))
      first = courseJoinLinks.createJoinLink(
        organizationId,
        {
          courseId: course.id,
          secretHash: 'hash-1',
          createdByAccountId: ownerId,
        },
        testDb.db
      )
      vi.setSystemTime(new Date('2026-08-31T00:00:00.001Z'))
      second = courseJoinLinks.createJoinLink(
        organizationId,
        {
          courseId: course.id,
          secretHash: 'hash-2',
          createdByAccountId: ownerId,
        },
        testDb.db
      )
    } finally {
      vi.useRealTimers()
    }

    const listed = courseJoinLinks.listJoinLinks(
      organizationId,
      course.id,
      testDb.db
    )

    expect(listed.map((link) => link.id)).toEqual([second.id, first.id])
  })

  // Fails without the fix: before `listJoinLinks` existed, there was no way
  // for a caller to read a course's join links back at all.
  it("does not list another organization's course join links", () => {
    testDb = createTestDatabase()
    const {
      organizationId: orgA,
      course: courseA,
      ownerId: ownerA,
    } = seedOrganizationWithCourse(testDb)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb)

    courseJoinLinks.createJoinLink(
      orgA,
      {
        courseId: courseA.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerA,
      },
      testDb.db
    )

    expect(courseJoinLinks.listJoinLinks(orgB, courseA.id, testDb.db)).toEqual(
      []
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

describe('course-join-links repo — redeemJoinLinkForWebAccount (ENRL-8)', () => {
  // ENRL-8: a signed-in web account with no person in the link's own
  // organization yet gets one, created and connected through the real
  // `people.ts#connectIdentity` path — never a raw `connectedAt` write.
  // Fails without the fix: `redeemJoinLink` refuses outright (`getPerson`
  // finds no row for a bare account id).
  it('creates and connects a web person for an account with none in this organization, then enrols it', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const accountId = randomUUID()

    courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const enrolment = courseJoinLinks.redeemJoinLinkForWebAccount(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )

    expect(enrolment?.source).toBe('join_link')
    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: accountId },
      testDb.db
    )
    expect(person).toBeDefined()
    // Connected through the real path, not a raw column write — the same
    // property `createConnectedWebPerson`'s own test coverage
    // (`@bloombot/auth`) checks for its identical shape.
    expect(person?.connectedAt).not.toBeNull()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person?.id ?? '',
        testDb.db
      )
    ).toMatchObject({ id: enrolment?.id })
  })

  // A second redemption by the same account must not mint a second person —
  // idempotent the same way `enrolViaJoinLink`'s own idempotence already is.
  it('reuses the same web person on a second redemption rather than creating another', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const accountId = randomUUID()

    courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const first = courseJoinLinks.redeemJoinLinkForWebAccount(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )
    const second = courseJoinLinks.redeemJoinLinkForWebAccount(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )

    expect(second?.id).toBe(first?.id)
    expect(
      enrolments.listPeopleForCourse(organizationId, course.id, testDb.db)
    ).toHaveLength(1)
  })

  // A signed-in account that already has a connected person in this
  // organization (a Discord identity a roster or role admitted, since
  // merged onto this same account) is enrolled through that existing
  // person, not a second, freshly-minted one.
  it("enrols the account's existing connected person, rather than creating a second one", () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const accountId = randomUUID()
    const existingPerson = people.createPerson(organizationId, {}, testDb.db)
    const connected = people.connectIdentity(
      organizationId,
      existingPerson.id,
      { surface: 'web', externalId: accountId },
      testDb.db
    )
    if (!connected) throw new Error('setup failed')

    courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const enrolment = courseJoinLinks.redeemJoinLinkForWebAccount(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        existingPerson.id,
        testDb.db
      )
    ).toMatchObject({ id: enrolment?.id })
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(1)
  })

  // A body-supplied identity cannot redirect the enrolment to anyone else —
  // this function's own second parameter is the account id a session
  // already proved, never a person id a caller names; there is no argument
  // here through which "enrol somebody else" could even be expressed. Two
  // different accounts redeeming the same (multi-use) link get two
  // different people, each enrolled only themselves.
  it('two different accounts redeeming the same link each enrol only themselves', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const accountA = randomUUID()
    const accountB = randomUUID()

    courseJoinLinks.createJoinLink(
      organizationId,
      {
        courseId: course.id,
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    courseJoinLinks.redeemJoinLinkForWebAccount(
      'hash-1',
      accountA,
      Date.now(),
      testDb.db
    )
    courseJoinLinks.redeemJoinLinkForWebAccount(
      'hash-1',
      accountB,
      Date.now(),
      testDb.db
    )

    expect(
      enrolments.listPeopleForCourse(organizationId, course.id, testDb.db)
    ).toHaveLength(2)
  })

  // --- ENRL-4: refusals are byte-identical, and add no side effect --------

  it('refuses a hash that was never issued, creating no person', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithCourse(testDb)
    const accountId = randomUUID()

    expect(
      courseJoinLinks.redeemJoinLinkForWebAccount(
        'never-issued',
        accountId,
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(0)
  })

  it('a revoked link admits nobody, creating no person', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const accountId = randomUUID()

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
      courseJoinLinks.redeemJoinLinkForWebAccount(
        'hash-1',
        accountId,
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(0)
  })

  it('an expired link admits nobody, creating no person', () => {
    testDb = createTestDatabase()
    const { organizationId, course, ownerId } =
      seedOrganizationWithCourse(testDb)
    const accountId = randomUUID()
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
      courseJoinLinks.redeemJoinLinkForWebAccount(
        'hash-1',
        accountId,
        now,
        testDb.db
      )
    ).toBeUndefined()
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(0)
  })
})
