import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  courses,
  enrolments,
  organizations,
  people,
  projects,
  selfEnrolment,
  type courses as coursesRepo,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds an organization with one enabled course carrying `selfEnrolFromDiscord` on — synthetic data only (QA-3). */
function seedOrganizationWithSelfEnrolCourse(
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
      enabled: true,
      adminsRole: 'admins-wd-fa26',
      studentsRole: 'students-wd-fa26',
      selfEnrolFromDiscord: true,
      categories: [],
      ...overrides,
    },
    testDatabase.db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return { organizationId, course: result.course }
}

describe('self-enrolment repo (ENRL-13)', () => {
  // --- recordSelfEnrolmentIntent: idempotent, one row per pairing --------

  it('recording the same intent twice produces one row, not two', () => {
    testDb = createTestDatabase()
    const { organizationId, course } =
      seedOrganizationWithSelfEnrolCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const first = selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    const second = selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    expect(first).toBeDefined()
    expect(second).toMatchObject({ id: first?.id })

    const rows = testDb.db.$client
      .prepare(
        'select count(*) as count from course_self_enrolment_intents where organization_id = ? and course_id = ? and person_id = ?'
      )
      .get(organizationId, course.id, person.id) as { count: number }
    expect(rows.count).toBe(1)
  })

  // --- the partial unique index: structural, not merely repo behaviour ---

  it('refuses a second unredeemed intent for the same (organization, course, person) at the database level', () => {
    testDb = createTestDatabase()
    const { organizationId, course } =
      seedOrganizationWithSelfEnrolCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    // Bypasses the repo layer's own idempotent lookup, the same way
    // `enrolments.test.ts`'s own unique-index tests do — inserting a second
    // row directly proves the index itself refuses it, not merely that the
    // repo function happens to check first.
    expect(() =>
      testDb.db.$client
        .prepare(
          'insert into course_self_enrolment_intents (id, organization_id, course_id, person_id, created_at, redeemed_at) values (?, ?, ?, ?, ?, null)'
        )
        .run(randomUUID(), organizationId, course.id, person.id, Date.now())
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('allows a second intent once the first has been redeemed — the index is partial, not plain', () => {
    testDb = createTestDatabase()
    const { organizationId, course } =
      seedOrganizationWithSelfEnrolCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const first = selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!first) throw new Error('setup failed: no intent')
    testDb.db.$client
      .prepare(
        'update course_self_enrolment_intents set redeemed_at = ? where id = ?'
      )
      .run(Date.now(), first.id)

    expect(() =>
      testDb.db.$client
        .prepare(
          'insert into course_self_enrolment_intents (id, organization_id, course_id, person_id, created_at, redeemed_at) values (?, ?, ?, ?, ?, null)'
        )
        .run(randomUUID(), organizationId, course.id, person.id, Date.now())
    ).not.toThrow()
  })

  // --- redeemSelfEnrolmentIntents: connecting is what admits -------------

  it('redeems an unconnected student into an enrolment once they connect', () => {
    testDb = createTestDatabase()
    const { organizationId, course } =
      seedOrganizationWithSelfEnrolCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    selfEnrolment.redeemSelfEnrolmentIntents(
      organizationId,
      person.id,
      testDb.db
    )

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toMatchObject({ source: 'self_enrolment' })
  })

  it('redeems an intent once — a second redemption sweep does not duplicate the enrolment or re-process it', () => {
    testDb = createTestDatabase()
    const { organizationId, course } =
      seedOrganizationWithSelfEnrolCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const intent = selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!intent) throw new Error('setup failed: no intent')

    selfEnrolment.redeemSelfEnrolmentIntents(
      organizationId,
      person.id,
      testDb.db
    )
    const row = testDb.db.$client
      .prepare(
        'select redeemed_at from course_self_enrolment_intents where id = ?'
      )
      .get(intent.id) as { redeemed_at: number }
    expect(row.redeemed_at).toEqual(expect.any(Number))

    // Running the sweep again finds nothing left unredeemed — this is not
    // asserted by re-checking the enrolment (still exactly one, from the
    // `admit` idempotence `enrolViaSelfEnrolment` already inherits) but by
    // the intent's own `redeemedAt` staying exactly what it was set to the
    // first time, not bumped by a second, needless redemption.
    selfEnrolment.redeemSelfEnrolmentIntents(
      organizationId,
      person.id,
      testDb.db
    )
    const rowAfter = testDb.db.$client
      .prepare(
        'select redeemed_at from course_self_enrolment_intents where id = ?'
      )
      .get(intent.id) as { redeemed_at: number }
    expect(rowAfter.redeemed_at).toBe(row.redeemed_at)
  })

  // --- redemption re-checks the course's own setting, not just at record time ---

  it('redeems an intent as redeemed-but-not-enrolled once the course has turned selfEnrolFromDiscord back off', () => {
    testDb = createTestDatabase()
    const { organizationId, course } =
      seedOrganizationWithSelfEnrolCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const intent = selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!intent) throw new Error('setup failed: no intent')

    // The setting is turned off between the message and the connect —
    // exactly the case this repo's own doc comment calls out.
    courses.updateCourse(
      organizationId,
      course.id,
      {
        projectId: course.projectId,
        title: course.title,
        enabled: course.enabled,
        adminsRole: course.adminsRole,
        studentsRole: course.studentsRole,
        selfEnrolFromDiscord: false,
        categories: [],
      },
      testDb.db
    )

    selfEnrolment.redeemSelfEnrolmentIntents(
      organizationId,
      person.id,
      testDb.db
    )

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeUndefined()
    const row = testDb.db.$client
      .prepare(
        'select redeemed_at from course_self_enrolment_intents where id = ?'
      )
      .get(intent.id) as { redeemed_at: number | null }
    // Redeemed regardless — not retried forever on every later connect.
    expect(row.redeemed_at).toEqual(expect.any(Number))
  })

  // --- ENRL-6: the hard constraint, from the connect side this time ------

  it("an instructor-ended enrolment stays ended even though the student's intent is later redeemed", () => {
    testDb = createTestDatabase()
    const { organizationId, course } =
      seedOrganizationWithSelfEnrolCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    // Admitted once already (the message-while-connected path), then ended
    // by an instructor.
    const first = enrolments.enrolViaSelfEnrolment(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!first) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, first.id, testDb.db)

    // A later message (say, from a second, still-unconnected identity of
    // the same person) records a fresh intent.
    selfEnrolment.recordSelfEnrolmentIntent(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    selfEnrolment.redeemSelfEnrolmentIntents(
      organizationId,
      person.id,
      testDb.db
    )

    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeUndefined()
    expect(
      enrolments.getEnrolment(organizationId, first.id, testDb.db)
    ).toMatchObject({ id: first.id, endedAt: expect.any(Number) })
  })
})
