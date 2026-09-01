import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  conversations,
  courses,
  enrolments,
  organizations,
  people,
  projects,
  type courses as coursesRepo,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds an organization with one enabled course, synthetic data only (QA-3). */
function seedOrganizationWithCourse(
  testDatabase: TestDatabase,
  overrides: Partial<coursesRepo.NewCourse> = {}
) {
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
      ...overrides,
    },
    testDatabase.db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return { organizationId, course: result.course }
}

describe('enrolments repo (ENRL-1..6)', () => {
  // --- ENRL-1/ENRL-2: a person's list is exactly their enrolments --------

  it("lists only a person's own enrolled courses", () => {
    testDb = createTestDatabase()
    const { organizationId, course: courseA } =
      seedOrganizationWithCourse(testDb)
    const { course: courseB } = (() => {
      const project = projects.createProject(
        organizationId,
        { name: 'Second course project' },
        testDb.db
      )
      const result = courses.createCourse(
        organizationId,
        {
          projectId: project.id,
          title: 'Data Structures',
          filePrefix: 'ds',
          enabled: true,
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'students-ds-fa26',
          categories: [],
        },
        testDb.db
      )
      if (!result.ok) throw new Error('setup failed: unexpected conflict')
      return { course: result.course }
    })()
    const person = people.createPerson(organizationId, {}, testDb.db)

    enrolments.enrolViaRoster(
      organizationId,
      { courseId: courseA.id, personId: person.id },
      testDb.db
    )

    const listed = enrolments.listCoursesForPerson(
      organizationId,
      person.id,
      testDb.db
    )

    expect(listed.map((c) => c.id)).toEqual([courseA.id])
    expect(listed.map((c) => c.id)).not.toContain(courseB.id)
  })

  // Cheap-fix 10: a disabled course routes nothing (CORE-2,
  // `@bloombot/core`'s `routing.ts`) — this list must not offer one either,
  // or a course `checkEnrolmentAccessAction` still permits reads as
  // "you may ask this" for a course routing silently drops. The enrolment
  // itself is untouched (D-34's own "what disabling a course does to an
  // enrolment: nothing") — it simply stops appearing here while disabled.
  it('excludes a disabled course, even though the enrolment itself is untouched', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    courses.disableCourse(organizationId, course.id, testDb.db)

    expect(
      enrolments.listCoursesForPerson(organizationId, person.id, testDb.db)
    ).toEqual([])
    // The enrolment itself is still active — only the listing changed.
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeDefined()
  })

  it('has no active enrolment for a course the person was never admitted to', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeUndefined()
  })

  // --- ENRL-3: each of the three paths creates its own source ------------

  it('enrolViaRoster records source "roster"', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    expect(enrolment?.source).toBe('roster')
  })

  it('enrolViaDiscordRole records source "discord_role" when the person holds the course\'s student role', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const enrolment = enrolments.enrolViaDiscordRole(
      organizationId,
      {
        courseId: course.id,
        personId: person.id,
        roleNames: [course.studentsRole],
      },
      testDb.db
    )

    expect(enrolment?.source).toBe('discord_role')
  })

  it("enrolViaDiscordRole refuses a person who does not hold the course's student role", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.enrolViaDiscordRole(
        organizationId,
        {
          courseId: course.id,
          personId: person.id,
          roleNames: ['some-other-role'],
        },
        testDb.db
      )
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

  // Holding the course's own *admins* role must never admit anyone — ENRL-5's
  // "a Discord role confers none of them" also means the admin role has no
  // bearing on enrolment eligibility, only the student one does.
  it("enrolViaDiscordRole does not admit someone holding only the course's admin role", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.enrolViaDiscordRole(
        organizationId,
        {
          courseId: course.id,
          personId: person.id,
          roleNames: [course.adminsRole],
        },
        testDb.db
      )
    ).toBeUndefined()
  })

  it('there is no repo function that enrols with a caller-chosen source', () => {
    // Structural: `enrolments.ts` exports exactly three admission functions,
    // each with a fixed source, and no generic `enrol(..., { source })`.
    expect(Object.keys(enrolments).sort()).toEqual(
      [
        'enrolViaDiscordRole',
        'enrolViaJoinLink',
        'enrolViaRoster',
        'endEnrolment',
        'getActiveEnrolment',
        'getEnrolment',
        'listCoursesForPerson',
        'listPeopleForCourse',
      ].sort()
    )
  })

  it('enrolling the same person in the same course twice through the same path is idempotent, not a duplicate', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const first = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!first) throw new Error('setup failed: no enrolment')
    const second = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    expect(second?.id).toBe(first.id)
    expect(
      enrolments.listPeopleForCourse(organizationId, course.id, testDb.db)
    ).toHaveLength(1)
  })

  // --- Rework finding 2: `admit` refuses a foreign course or person, for
  // every `enrolVia*`, not only the join-link path `redeemJoinLink` already
  // checked for itself --------------------------------------------------

  it('enrolViaRoster refuses a courseId that does not belong to this organization', () => {
    testDb = createTestDatabase()
    const { course: courseA } = seedOrganizationWithCourse(testDb)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb)
    const personInOrgB = people.createPerson(orgB, {}, testDb.db)

    expect(
      enrolments.enrolViaRoster(
        orgB,
        { courseId: courseA.id, personId: personInOrgB.id },
        testDb.db
      )
    ).toBeUndefined()
    expect(
      enrolments.listPeopleForCourse(orgB, courseA.id, testDb.db)
    ).toHaveLength(0)
  })

  it('enrolViaRoster refuses a personId that does not belong to this organization', () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, course: courseA } =
      seedOrganizationWithCourse(testDb)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb)
    const personInOrgB = people.createPerson(orgB, {}, testDb.db)

    expect(
      enrolments.enrolViaRoster(
        orgA,
        { courseId: courseA.id, personId: personInOrgB.id },
        testDb.db
      )
    ).toBeUndefined()
    expect(
      enrolments.listPeopleForCourse(orgA, courseA.id, testDb.db)
    ).toHaveLength(0)
  })

  // --- Rework finding 3 / cheap-fix 9: reviving an ended enrolment -------

  // The load-bearing consequence of the partial unique index
  // (`enrolments_org_course_person_active_unique`, `schema.ts`'s own
  // comment): a person who holds an *ended* enrolment can still be admitted
  // again, as a genuinely new row, through a path that means to revive
  // them — `enrolViaJoinLink`'s own `reviveEnded: true`.
  it('re-enrolling through a path that means to revive creates a new, distinct row and leaves the ended one intact', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const first = enrolments.enrolViaJoinLink(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!first) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, first.id, testDb.db)

    const second = enrolments.enrolViaJoinLink(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    expect(second?.id).toBeDefined()
    expect(second?.id).not.toBe(first.id)
    expect(
      enrolments.getEnrolment(organizationId, first.id, testDb.db)
    ).toMatchObject({ endedAt: expect.any(Number) })
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toMatchObject({ id: second?.id })
  })

  // A roster re-import must not do what the test above proves
  // `enrolViaJoinLink` deliberately does — reviving an ended enrolment.
  // Fails without the fix: before `admit` gained `reviveEnded`, this same
  // call sequence produced a brand-new active row here too, silently
  // undoing the `endEnrolment` call an instructor made on purpose (ENRL-6).
  it('enrolViaRoster does not revive an ended enrolment', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const first = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!first) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, first.id, testDb.db)

    const second = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    expect(second).toBeUndefined()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeUndefined()
    // The original row is still there, still ended — not deleted, not
    // reactivated.
    expect(
      enrolments.getEnrolment(organizationId, first.id, testDb.db)
    ).toMatchObject({ id: first.id, endedAt: expect.any(Number) })
  })

  // --- ENRL-6: ending an enrolment stops asking, deletes nothing ---------

  it("ending an enrolment removes it from the person's active list but leaves the transcript and course messages untouched", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('setup failed: no conversation')
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'from_person', content: 'How do I center a div?' },
      testDb.db
    )
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'to_person', content: 'With flexbox.' },
      testDb.db
    )

    const transcriptBefore = conversations.getTranscript(
      organizationId,
      conversation.id,
      testDb.db
    )
    expect(transcriptBefore).toHaveLength(2)

    const changed = enrolments.endEnrolment(
      organizationId,
      enrolment.id,
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
    ).toBeUndefined()
    expect(
      enrolments.listCoursesForPerson(organizationId, person.id, testDb.db)
    ).toHaveLength(0)

    // The enrolment row itself still exists — ended, not deleted.
    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({ id: enrolment.id, endedAt: expect.any(Number) })

    const transcriptAfter = conversations.getTranscript(
      organizationId,
      conversation.id,
      testDb.db
    )
    expect(transcriptAfter).toHaveLength(2)
    expect(transcriptAfter).toEqual(transcriptBefore)
  })

  it('ending an already-ended enrolment is an idempotent no-op', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    expect(
      enrolments.endEnrolment(organizationId, enrolment.id, testDb.db)
    ).toBe(1)
    expect(
      enrolments.endEnrolment(organizationId, enrolment.id, testDb.db)
    ).toBe(0)
  })

  // --- Tenant scoping (TEN-2/TEN-5) ---------------------------------------

  it("does not read another organization's enrolment through the wrong organization", () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, course: courseA } =
      seedOrganizationWithCourse(testDb, {
        adminsRole: 'admins-a',
        studentsRole: 'students-a',
      })
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb, {
      adminsRole: 'admins-b',
      studentsRole: 'students-b',
    })
    const person = people.createPerson(orgA, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      orgA,
      { courseId: courseA.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    expect(
      enrolments.getActiveEnrolment(orgB, courseA.id, person.id, testDb.db)
    ).toBeUndefined()
    expect(
      enrolments.getEnrolment(orgB, enrolment.id, testDb.db)
    ).toBeUndefined()
    expect(enrolments.endEnrolment(orgB, enrolment.id, testDb.db)).toBe(0)
    expect(
      enrolments.getActiveEnrolment(orgA, courseA.id, person.id, testDb.db)
    ).toBeDefined()
  })
})
