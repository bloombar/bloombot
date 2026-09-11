import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
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
        roleNames: [course.studentsRole as string], // PROJ-7: seeded non-null above.
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

  // ENRL-7: "anyone a course is taught through is enrolled by asking it" —
  // an admins-role holder (an instructor or TA) is admitted exactly like a
  // students-role holder, so the web surface (which authorizes on this
  // table, not a membership) does not refuse the same person Discord just
  // answered. Fails without the fix: before ENRL-7, `enrolViaDiscordRole`
  // checked `studentsRole` only, and this call returned `undefined`.
  it("enrolViaDiscordRole admits someone holding only the course's admin role", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const enrolment = enrolments.enrolViaDiscordRole(
      organizationId,
      {
        courseId: course.id,
        personId: person.id,
        roleNames: [course.adminsRole as string], // PROJ-7: seeded non-null above.
      },
      testDb.db
    )

    expect(enrolment?.source).toBe('discord_role')
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeDefined()
  })

  it("enrolViaDiscordRole refuses a person holding neither of the course's two roles", () => {
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
  })

  // ENRL-7's widening never reversed ENRL-6: an admins-role holder an
  // instructor has explicitly ended stays ended, exactly like a
  // students-role holder (`enrolViaDiscordRole`'s own `reviveEnded: false`).
  it("enrolViaDiscordRole does not revive an admin-role holder's ended enrolment", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const first = enrolments.enrolViaDiscordRole(
      organizationId,
      {
        courseId: course.id,
        personId: person.id,
        roleNames: [course.adminsRole as string], // PROJ-7: seeded non-null above.
      },
      testDb.db
    )
    if (!first) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, first.id, testDb.db)

    const second = enrolments.enrolViaDiscordRole(
      organizationId,
      {
        courseId: course.id,
        personId: person.id,
        roleNames: [course.adminsRole as string], // PROJ-7: seeded non-null above.
      },
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
  })

  it('there is no repo function that enrols with a caller-chosen source', () => {
    // Structural: `enrolments.ts` exports exactly four admission functions
    // (ENRL-13 added the fourth), each with a fixed source, and no generic
    // `enrol(..., { source })`. ENRL-15/16 added two more exports —
    // `resolveChatAdmission`/`listChatAdmittedCourses` — neither of which
    // enrols anybody at all (both are pure reads; `routes/chat.ts`'s own
    // `POST` handler is what decides whether to call `enrolViaSelfEnrolment`
    // off the back of one), so they are listed here too rather than this
    // test narrowing to a subset that would stop noticing a *real* new
    // enrolling function landing beside them unchecked.
    expect(Object.keys(enrolments).sort()).toEqual(
      [
        'enrolViaDiscordRole',
        'enrolViaJoinLink',
        'enrolViaRoster',
        'enrolViaSelfEnrolment',
        'endEnrolment',
        'reinstateEnrolment',
        'getActiveEnrolment',
        'getEnrolment',
        'hasEndedEnrolment',
        'listCoursesForPerson',
        'listPeopleForCourse',
        'listEnrolmentsForCourse',
        'resolveChatAdmission',
        'listChatAdmittedCourses',
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

  // --- Rework finding 3 / cheap-fix 9, and the ENRL-6/ENRL-8 rework -------

  // ENRL-6/ENRL-8 rework — this test used to prove the opposite: that
  // `enrolViaJoinLink`'s own `reviveEnded: true` created a genuinely new row
  // for a person an instructor had already ended. That premise held only
  // while `redeemJoinLink` had no live caller (see `docs/DECISIONS.md`);
  // once ENRL-8 wired a real, student-initiated redemption route to it, the
  // same behaviour let the removed person undo their own removal by
  // re-submitting the class's shared secret. Fails without the fix: before
  // `enrolViaJoinLink` was reversed to `reviveEnded: false`, redeeming the
  // same link again after `endEnrolment` produced a brand-new active row.
  it("enrolViaJoinLink does not revive an ended enrolment — a link redeemed again must not undo an instructor's ENRL-6 decision", () => {
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

  // A roster re-import does not revive an ended enrolment either —
  // `enrolViaRoster`'s own `reviveEnded: false` is unchanged by this
  // rework (the brief for it explicitly leaves this function alone).
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

  // ENRL-13 — the fourth `enrolVia*`, exercised the same way its three
  // siblings are above: records source `'self_enrolment'`, and refuses to
  // revive a prior *ended* enrolment. Fails without the change: before
  // `enrolViaSelfEnrolment` existed, this call did not compile at all, and
  // before `'self_enrolment'` was added to `ENROLMENT_SOURCES` and to
  // `enrolments_source_check`, the insert would have thrown a raw
  // `SQLITE_CONSTRAINT_CHECK` rather than a source ever reading back this
  // way.
  it('enrolViaSelfEnrolment records source "self_enrolment"', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const enrolment = enrolments.enrolViaSelfEnrolment(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    expect(enrolment).toMatchObject({ source: 'self_enrolment' })
  })

  // ENRL-6/ENRL-13 — the hard constraint the brief calls out explicitly: an
  // instructor-ended enrolment stays ended, whether the next message came
  // from a Discord-role holder (the test above, `enrolViaDiscordRole`) or
  // from a course's own self-enrolment setting. Fails without
  // `enrolViaSelfEnrolment`'s own `reviveEnded: false`.
  it('enrolViaSelfEnrolment does not revive an ended enrolment', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)

    const first = enrolments.enrolViaSelfEnrolment(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!first) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, first.id, testDb.db)

    const second = enrolments.enrolViaSelfEnrolment(
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

  // --- ENRL-9: reinstating an ended enrolment -----------------------------

  it('reinstates an ended enrolment, restoring active access and recording who and when', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor@example.edu',
        displayName: 'Instructor',
        role: 'owner',
      },
      testDb.db
    )
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, enrolment.id, testDb.db)
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        person.id,
        testDb.db
      )
    ).toBeUndefined()

    const changed = enrolments.reinstateEnrolment(
      organizationId,
      enrolment.id,
      { reinstatedByAccountId: instructor.id },
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
    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({
      endedAt: null,
      reinstatedByAccountId: instructor.id,
      reinstatedAt: expect.any(Number),
    })
  })

  it('reinstating an enrolment that is not ended is an idempotent no-op — nothing changes', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor2@example.edu',
        displayName: 'Instructor',
        role: 'owner',
      },
      testDb.db
    )
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    const changed = enrolments.reinstateEnrolment(
      organizationId,
      enrolment.id,
      { reinstatedByAccountId: instructor.id },
      testDb.db
    )

    expect(changed).toBe(0)
    // Never-ended, never-reinstated — this call left it exactly as it was.
    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({
      endedAt: null,
      reinstatedByAccountId: null,
      reinstatedAt: null,
    })
  })

  it("reinstateEnrolment refuses another organization's enrolment (TEN-5)", () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, course: courseA } =
      seedOrganizationWithCourse(testDb)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(orgA, {}, testDb.db)
    const outsider = accounts.createAccount(
      orgB,
      { email: 'outsider@example.edu', displayName: 'Outsider', role: 'owner' },
      testDb.db
    )
    const enrolment = enrolments.enrolViaRoster(
      orgA,
      { courseId: courseA.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(orgA, enrolment.id, testDb.db)

    const changed = enrolments.reinstateEnrolment(
      orgB,
      enrolment.id,
      { reinstatedByAccountId: outsider.id },
      testDb.db
    )

    expect(changed).toBe(0)
    expect(
      enrolments.getActiveEnrolment(orgA, courseA.id, person.id, testDb.db)
    ).toBeUndefined()
  })

  // Must-fix (rework): `reinstateEnrolment`'s own doc comment used to claim
  // "there is never more than one row for a given pairing once any
  // `enrolVia*` has run" — false. `people.mergePeople` reaches exactly the
  // opposite shape whenever a loser's own enrolment for a course is
  // *already ended* before the merge: that branch moves the row's
  // `personId` onto the survivor outright, with no check for whether the
  // survivor already holds an *active* row for the same course
  // (`people.ts#mergePeople`'s own "no unique constraint to collide with"
  // reasoning — true for the move itself, since the partial unique index
  // only restricts active rows, but it leaves the survivor holding both an
  // active row and this newly-moved ended row for the identical
  // `(organizationId, courseId, personId)`). Reinstating that moved row
  // then collides with the survivor's own active one on
  // `enrolments_org_course_person_active_unique`. Before the fix, this
  // reached the caller as an unhandled `SQLITE_CONSTRAINT_UNIQUE`.
  it('reinstating an ended enrolment that collides with an active one after a merge is a clean no-op, not a thrown constraint error', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const account = accounts.createAccount(
      organizationId,
      { email: 'merge-owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    // The loser: enrolled, then ended, *before* the merge — the branch
    // `mergePeople` moves outright with no collision check.
    const loser = people.createPerson(organizationId, {}, testDb.db)
    const loserEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: loser.id },
      testDb.db
    )
    if (!loserEnrolment) throw new Error('setup failed: no loser enrolment')
    enrolments.endEnrolment(organizationId, loserEnrolment.id, testDb.db)

    // The survivor: already actively enrolled in the same course.
    const survivor = people.createPerson(organizationId, {}, testDb.db)
    const survivorEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: survivor.id },
      testDb.db
    )
    if (!survivorEnrolment)
      throw new Error('setup failed: no survivor enrolment')

    const merge = people.mergePeople(
      organizationId,
      survivor.id,
      loser.id,
      testDb.db
    )
    if (!merge) throw new Error('setup failed: merge refused')

    // The moved row now shares (organizationId, courseId, personId) with
    // the survivor's own still-active enrolment.
    const movedLoserEnrolment = enrolments.getEnrolment(
      organizationId,
      loserEnrolment.id,
      testDb.db
    )
    expect(movedLoserEnrolment).toMatchObject({
      personId: survivor.id,
      courseId: course.id,
      endedAt: expect.any(Number),
    })
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        survivor.id,
        testDb.db
      )?.id
    ).toBe(survivorEnrolment.id)

    // Reinstating the moved, now-colliding row is a clean no-op — not a
    // thrown `SQLITE_CONSTRAINT_UNIQUE`.
    expect(() =>
      enrolments.reinstateEnrolment(
        organizationId,
        loserEnrolment.id,
        { reinstatedByAccountId: account.id },
        testDb.db
      )
    ).not.toThrow()
    const changed = enrolments.reinstateEnrolment(
      organizationId,
      loserEnrolment.id,
      { reinstatedByAccountId: account.id },
      testDb.db
    )
    expect(changed).toBe(0)

    // Nothing changed: the moved row is still ended, still unreinstated,
    // and the survivor's original active row is still the only active one.
    expect(
      enrolments.getEnrolment(organizationId, loserEnrolment.id, testDb.db)
    ).toMatchObject({
      endedAt: expect.any(Number),
      reinstatedByAccountId: null,
    })
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        survivor.id,
        testDb.db
      )?.id
    ).toBe(survivorEnrolment.id)
  })

  // --- WEB-22: the panel's own listing, active and ended alike -----------

  it('listEnrolmentsForCourse includes both an active and an ended enrolment, with source and endedAt', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const active = people.createPerson(
      organizationId,
      { displayName: 'Ada Lovelace' },
      testDb.db
    )
    const ended = people.createPerson(
      organizationId,
      { displayName: 'Bob Babbage' },
      testDb.db
    )
    const activeEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: active.id },
      testDb.db
    )
    const endedEnrolment = enrolments.enrolViaDiscordRole(
      organizationId,
      {
        courseId: course.id,
        personId: ended.id,
        roleNames: [course.studentsRole as string], // PROJ-7: seeded non-null above.
      },
      testDb.db
    )
    if (!activeEnrolment || !endedEnrolment) {
      throw new Error('setup failed: no enrolment')
    }
    enrolments.endEnrolment(organizationId, endedEnrolment.id, testDb.db)

    const listed = enrolments.listEnrolmentsForCourse(
      organizationId,
      course.id,
      testDb.db
    )

    expect(listed).toHaveLength(2)
    const activeRow = listed.find((row) => row.personId === active.id)
    const endedRow = listed.find((row) => row.personId === ended.id)
    expect(activeRow).toMatchObject({
      source: 'roster',
      endedAt: null,
    })
    expect(endedRow).toMatchObject({
      source: 'discord_role',
      endedAt: expect.any(Number),
    })
  })

  // Cheap-fix (rework): without deduping by person, the merge shape above
  // (a survivor holding both an active row and a stray, moved-in ended row
  // for the same course) listed the survivor twice — once per row — with a
  // "Reinstate" offered on the stray row that could only ever no-op.
  it('listEnrolmentsForCourse lists a person at most once, even when a merge leaves them with two rows for the same course', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)

    const loser = people.createPerson(
      organizationId,
      { displayName: 'Loser' },
      testDb.db
    )
    const loserEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: loser.id },
      testDb.db
    )
    if (!loserEnrolment) throw new Error('setup failed: no loser enrolment')
    enrolments.endEnrolment(organizationId, loserEnrolment.id, testDb.db)

    const survivor = people.createPerson(
      organizationId,
      { displayName: 'Survivor' },
      testDb.db
    )
    const survivorEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: survivor.id },
      testDb.db
    )
    if (!survivorEnrolment) {
      throw new Error('setup failed: no survivor enrolment')
    }

    const merge = people.mergePeople(
      organizationId,
      survivor.id,
      loser.id,
      testDb.db
    )
    if (!merge) throw new Error('setup failed: merge refused')

    const listed = enrolments.listEnrolmentsForCourse(
      organizationId,
      course.id,
      testDb.db
    )

    // Exactly one row for the survivor — the active one, not the stray
    // ended row the merge moved onto them.
    const survivorRows = listed.filter((row) => row.personId === survivor.id)
    expect(survivorRows).toHaveLength(1)
    expect(survivorRows[0]).toMatchObject({
      id: survivorEnrolment.id,
      endedAt: null,
    })
  })

  it("listEnrolmentsForCourse is scoped to this organization's course — a foreign organization sees none of it", () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, course: courseA } =
      seedOrganizationWithCourse(testDb)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb)
    const person = people.createPerson(orgA, {}, testDb.db)
    enrolments.enrolViaRoster(
      orgA,
      { courseId: courseA.id, personId: person.id },
      testDb.db
    )

    expect(
      enrolments.listEnrolmentsForCourse(orgB, courseA.id, testDb.db)
    ).toEqual([])
    expect(
      enrolments.listEnrolmentsForCourse(orgA, courseA.id, testDb.db)
    ).toHaveLength(1)
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

// ENRL-15/16 — the predicate `apps/api/src/routes/chat.ts` shares between
// its list and its per-course read/write, tested at the repo layer against
// every admission path it decides between (`enrolments.ts`'s own module
// comment on `ChatAdmission` has the full reasoning; `docs/DECISIONS.md`
// D-101 has how this shape was arrived at). Every course below is left at
// `courses.createCourse`'s own real defaults (`answerUnenrolled: true`
// among them) unless a test says otherwise.
describe('enrolments repo — resolveChatAdmission/listChatAdmittedCourses (ENRL-15/16)', () => {
  it("admits this organization's owner to a course they were never enrolled in, on real default settings (ENRL-15)", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: owner.id },
        testDb.db
      )
    ).toEqual({ kind: 'owner' })
    expect(
      enrolments
        .listChatAdmittedCourses(
          organizationId,
          { personId: person.id, accountId: owner.id },
          testDb.db
        )
        .map((c) => c.id)
    ).toEqual([course.id])
  })

  // The reported bug, finally fixed by a rule that does not leak: an
  // instructor who is a member of the organization — not its owner, and
  // holding no enrolment of their own — is admitted to a course left at
  // `createCourse`'s own real default (`answerUnenrolled: true`), the
  // same way `@bloombot/discord`'s `handle-mention.ts` would answer them.
  it('admits a plain member (not the owner, no enrolment) to a default-settings course', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    expect(course.answerUnenrolled).toBe(true)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor@example.edu',
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual({ kind: 'answers-unenrolled' })
    expect(
      enrolments
        .listChatAdmittedCourses(
          organizationId,
          { personId: person.id, accountId: instructor.id },
          testDb.db
        )
        .map((c) => c.id)
    ).toEqual([course.id])
  })

  it('refuses a plain member on a course carrying neither setting', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb, {
      answerUnenrolled: false,
    })
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor@example.edu',
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual({ kind: 'refused' })
    expect(
      enrolments.listChatAdmittedCourses(
        organizationId,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual([])
  })

  // Both settings on, no enrolment — pins the precedence order
  // `admissionForCourse` (`repos/enrolments.ts`) holds itself to:
  // `selfEnrolFromDiscord` checked ahead of `answerUnenrolled`, so a
  // course carrying both reports `'self-enrol'`, not `'answers-unenrolled'`
  // — a plain kind check that a reviewer noted swapping the two lines in
  // `admissionForCourse` would not otherwise catch (both are true, so
  // either order "passes" a test that only checks *something* other than
  // `'refused'` came back).
  it('reports selfEnrolFromDiscord ahead of answerUnenrolled when a course carries both, pinning the precedence order', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb, {
      answerUnenrolled: true,
      selfEnrolFromDiscord: true,
    })
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor@example.edu',
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual({ kind: 'self-enrol' })
  })

  // Must-fix 1, at the repo layer, re-aimed at the caller it actually
  // targets: a *connected person who holds no membership at all* — the
  // account exists (created in its own, unrelated organization, the same
  // shape `routes/person-link.ts#/discord/begin` produces for a genuine
  // stranger who merely names an organization id) — must not be admitted
  // by a course's own settings, even on a course left at `createCourse`'s
  // own real default. This is the caller the leak was actually about; a
  // plain member (tested above) is deliberately not this caller.
  it('refuses a connected person with no membership at all, even on a course whose answerUnenrolled default is true (must-fix 1, no-leak)', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    expect(course.answerUnenrolled).toBe(true)
    const strangerOrganizationId = randomUUID()
    organizations.createOrganization(
      strangerOrganizationId,
      { name: "The stranger's own organization", isPersonal: false },
      testDb.db
    )
    const stranger = accounts.createAccount(
      strangerOrganizationId,
      { email: 'stranger@example.edu', displayName: 'Stranger', role: 'owner' },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: stranger.id },
        testDb.db
      )
    ).toEqual({ kind: 'refused' })
    expect(
      enrolments.listChatAdmittedCourses(
        organizationId,
        { personId: person.id, accountId: stranger.id },
        testDb.db
      )
    ).toEqual([])
  })

  // Must-fix 2, at the repo layer: an ended enrolment refuses
  // unconditionally, even for a plain member on a course carrying both
  // settings on — the identical priority `@bloombot/discord`'s own
  // `handle-mention.ts` gives its `enrolmentEnded` gate ahead of
  // ENRL-13/14. A member's own membership must not readmit them through
  // the course's settings once an instructor has ended their enrolment.
  it('refuses an ended enrolment unconditionally, even for a member on a course carrying both settings on (ENRL-6/ENRL-9, must-fix 2)', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb, {
      answerUnenrolled: true,
      selfEnrolFromDiscord: true,
    })
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor@example.edu',
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, enrolment.id, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual({ kind: 'refused' })
    expect(
      enrolments.listChatAdmittedCourses(
        organizationId,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual([])
  })

  // The order this pins: a review round found `admissionForCourse`
  // checking `isOwner` ahead of `hasEndedEnrolment`, which let the
  // organization's own owner keep chatting in a course after an
  // instructor ended their enrolment there — the one mutation (of eight
  // planted) that survived the rest of this file's own suite. ENRL-6 is
  // an instructor's deliberate act; an owner who disagrees can reinstate
  // it (ENRL-9), not have it silently overridden by holding the
  // organization's own top role.
  it("refuses the organization's own owner when their enrolment has been ended, even though owner otherwise admits unconditionally", () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, enrolment.id, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: owner.id },
        testDb.db
      )
    ).toEqual({ kind: 'refused' })
    expect(
      enrolments.listChatAdmittedCourses(
        organizationId,
        { personId: person.id, accountId: owner.id },
        testDb.db
      )
    ).toEqual([])
  })

  it('refuses a disabled course regardless of settings or membership', () => {
    testDb = createTestDatabase()
    // Pinned off, so this course's own admission is only ever the disabled
    // check itself — not entangled with the membership-based settings rule
    // this file's own other tests exercise.
    const { organizationId, course } = seedOrganizationWithCourse(testDb, {
      answerUnenrolled: false,
    })
    const disabled = seedOrganizationWithCourse(testDb, {
      answerUnenrolled: true,
      enabled: false,
      adminsRole: 'admins-disabled',
      studentsRole: 'students-disabled',
    })
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor@example.edu',
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual({ kind: 'refused' })
    expect(
      enrolments.resolveChatAdmission(
        disabled.organizationId,
        disabled.course.id,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual({ kind: 'refused' })
  })

  // "Also fix" from a review round: the only disabled-course test above
  // seeds it in a *second* organization and calls `resolveChatAdmission`
  // alone — that cannot catch `listChatAdmittedCourses` disagreeing with
  // it, since a disabled course in a different organization was never a
  // candidate for this organization's own list in the first place. A
  // disabled course in the *same* organization, with the caller enrolled
  // in it, is the shape that would actually expose the list and the
  // per-course read disagreeing.
  it("excludes a disabled course from the list even when the caller holds an active enrolment in it, in the caller's own organization", () => {
    testDb = createTestDatabase()
    // Pinned off — this test is about the disabled-course exclusion, not
    // about the membership-based settings rule this file's own other tests
    // exercise; left at the real default, the enabled course below would
    // also admit this member on its own settings, muddying what this test
    // is checking.
    const { organizationId, course: enabledCourse } =
      seedOrganizationWithCourse(testDb, {
        adminsRole: 'admins-enabled',
        studentsRole: 'students-enabled',
        answerUnenrolled: false,
      })
    const project = projects.getProject(
      organizationId,
      enabledCourse.projectId,
      testDb.db
    )
    if (!project) throw new Error('setup failed: no project')
    const disabledResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Retired Course',
        enabled: false,
        adminsRole: 'admins-disabled-same-org',
        studentsRole: 'students-disabled-same-org',
        categories: [],
      },
      testDb.db
    )
    if (!disabledResult.ok) throw new Error('setup failed: unexpected conflict')
    const disabledCourse = disabledResult.course

    const instructor = accounts.createAccount(
      organizationId,
      {
        email: 'instructor@example.edu',
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: disabledCourse.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    expect(
      enrolments
        .listChatAdmittedCourses(
          organizationId,
          { personId: person.id, accountId: instructor.id },
          testDb.db
        )
        .map((c) => c.id)
    ).toEqual([])
    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        disabledCourse.id,
        { personId: person.id, accountId: instructor.id },
        testDb.db
      )
    ).toEqual({ kind: 'refused' })
  })

  it('reports an active enrolment ahead of ownership', () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    expect(
      enrolments.resolveChatAdmission(
        organizationId,
        course.id,
        { personId: person.id, accountId: owner.id },
        testDb.db
      )
    ).toEqual({ kind: 'enrolled', enrolment })
  })
})
