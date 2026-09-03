/**
 * ENRL-9, over HTTP: `enrolments.reinstate`, proven the way access to a
 * course actually matters — through `routes/chat.ts`, which authorizes on
 * an *active* enrolment (`enrolments.getActiveEnrolment`), not merely
 * `endedAt` on the row — and proven that the reinstated person cannot
 * trigger this themselves.
 *
 * **What that second guarantee actually is, corrected after a review round
 * caught the original version of this file understating the attack.**
 * `routes/actions.ts` resolving the caller's organization from a
 * membership alone rules out a *stranger* — nothing else. It does not rule
 * out the reinstated person themselves: ENRL-7 admits anyone a course is
 * taught through (any membership role, including the lowest, `assistant`)
 * by *asking* it exactly like a plain student, so the identical account can
 * hold a staff membership in this organization for one course and, through
 * a separately connected `web` identity, an enrolment in another — being
 * enrolled and being a member are orthogonal facts about two different
 * tables. The test below proves the actual attack: an account with an
 * ordinary `assistant` membership in *this* organization, whose own web
 * identity is connected to the exact person an instructor just ended, gets
 * refused all the same — because `reinstateEnrolmentAction.execute` (not
 * the membership check upstream) compares the caller's own connected
 * person against the enrolment's `personId` and refuses on a match
 * (`actions/enrolments.ts`'s own doc comment on `reinstateEnrolmentAction`
 * has the full account, including the must-fix this replaced).
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import {
  courses,
  enrolments,
  people,
  projects,
  type Database,
} from '@bloombot/db'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import {
  seedSecondCallerInOrganization,
  seedSignedInCaller,
  type SignedInCaller,
} from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * A course in `caller`'s own organization, with a `discord`-surface person
 * already enrolled through `enrolViaRoster` — the same admission path a
 * real roster import uses, and the only kind of person any real enrolment
 * belongs to (`chat.test.ts`'s own `seedEnrolledCourse`, duplicated here in
 * miniature rather than imported — each of this app's own route test files
 * builds its own scenario, the same convention `chat.test.ts`'s own module
 * comment already follows).
 */
function seedEnrolledCourse(
  db: Database,
  caller: SignedInCaller
): { courseId: string; discordPersonId: string; enrolmentId: string } {
  const project = projects.createProject(
    caller.organizationId,
    { name: `Term ${randomUUID()}` },
    db
  )
  const unique = randomUUID()
  const created = courses.createCourse(
    caller.organizationId,
    {
      projectId: project.id,
      title: 'Intro to Testing',
      filePrefix: 'testing',
      enabled: true,
      adminsRole: `Staff-${unique}`,
      studentsRole: `Students-${unique}`,
      promptId: 'prompt-1',
      categories: [],
    },
    db
  )
  if (!created.ok) throw new Error('test setup: course creation refused')
  const discordPerson = people.resolvePersonByIdentity(
    caller.organizationId,
    { surface: 'discord', externalId: `discord-user-${randomUUID()}` },
    db
  )
  const enrolment = enrolments.enrolViaRoster(
    caller.organizationId,
    { courseId: created.course.id, personId: discordPerson.id },
    db
  )
  if (!enrolment) throw new Error('test setup: enrolment refused')
  return {
    courseId: created.course.id,
    discordPersonId: discordPerson.id,
    enrolmentId: enrolment.id,
  }
}

describe('enrolments.reinstate over HTTP (ENRL-9)', () => {
  it('an instructor ending, then reinstating, an enrolment removes and restores chat access', async () => {
    testDb = createTestDatabase()
    const instructor = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId, enrolmentId } = seedEnrolledCourse(
      testDb.db,
      instructor
    )
    // A second account in the same organization, connected to the enrolled
    // person — the same "signed in, proven by connecting" shape
    // `routes/chat.ts`'s own module comment describes for a real student's
    // web identity. `seedSecondCallerInOrganization` actually grants an
    // `assistant` membership (a correction to this comment: an earlier
    // revision called this "the student's own web account," which is not
    // what this helper mints — a plain student holds no membership at all,
    // and this scenario does not depend on which is true here, only that
    // `routes/chat.ts` authorizes on the connected person's own enrolment,
    // not on whatever membership the same account happens to also hold).
    const student = seedSecondCallerInOrganization(
      testDb.db,
      instructor.organizationId
    )
    const connected = people.connectIdentity(
      instructor.organizationId,
      discordPersonId,
      { surface: 'web', externalId: student.accountId },
      testDb.db
    )
    if (!connected) throw new Error('test setup: connectIdentity refused')

    const app = await buildTestApp(testDb.db)
    const ask = () =>
      request(app)
        .post(
          `/organizations/${instructor.organizationId}/chat/courses/${courseId}/messages`
        )
        .set('Cookie', student.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ text: 'Anybody there?' })

    // Baseline: the student can ask this course.
    expect((await ask()).status).toBe(200)

    // The instructor ends the enrolment (ENRL-6).
    const ended = await request(app)
      .post(
        `/organizations/${instructor.organizationId}/actions/enrolments.end`
      )
      .set('Cookie', instructor.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ enrolmentId })
    expect(ended.status).toBe(200)

    // `routes/chat.ts` authorizes on the active enrolment, not merely the
    // row's own existence — this fails without ENRL-9's own fix having
    // anything to do with it; it is `endEnrolment` alone.
    expect((await ask()).status).toBe(404)

    // The instructor reinstates it (ENRL-9) — fails without this slice's
    // own `enrolments.reinstate` action and `reinstateEnrolment` repo call.
    const reinstated = await request(app)
      .post(
        `/organizations/${instructor.organizationId}/actions/enrolments.reinstate`
      )
      .set('Cookie', instructor.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ enrolmentId })
    expect(reinstated.status).toBe(200)
    expect(
      (reinstated.body as { result: { reinstated: boolean } }).result
    ).toEqual({ reinstated: true })

    // Access through the exact same route `routes/chat.ts` authorizes,
    // restored — not merely the row's own `endedAt` cleared.
    expect((await ask()).status).toBe(200)

    // ENRL-9's own "recorded: who did it and when."
    expect(
      enrolments.getEnrolment(instructor.organizationId, enrolmentId, testDb.db)
    ).toMatchObject({
      endedAt: null,
      reinstatedByAccountId: instructor.accountId,
      reinstatedAt: expect.any(Number),
    })
  })

  // The must-fix a review round caught: this used to seed the "removed
  // person" a fresh organization of their own (`seedSignedInCaller`),
  // which only ever proves `tenant-isolation.test.ts`'s generic "a foreign
  // session is refused" — not "connected to the enrolled person, holding
  // an ordinary membership *inside this same organization*," which is the
  // actual shape ENRL-7 makes possible and the actual shape both reviewers
  // reproduced over HTTP (a TA's own, separate enrolment in a different
  // course, reinstated by themselves, with the audit column naming them as
  // the actor). Rewritten to that real scenario.
  it('an account with an ordinary membership in this organization cannot reinstate its own connected enrolment', async () => {
    testDb = createTestDatabase()
    const instructor = seedSignedInCaller(testDb.db)
    const { discordPersonId, enrolmentId } = seedEnrolledCourse(
      testDb.db,
      instructor
    )
    // ENRL-7's own shape: a second account, an ordinary `assistant`
    // membership in the *same* organization (a TA for some other course,
    // say) — never a stranger, and never a different tenant — whose own
    // web identity is separately connected to the exact person this
    // course's enrolment names.
    const removedPerson = seedSecondCallerInOrganization(
      testDb.db,
      instructor.organizationId
    )
    const connected = people.connectIdentity(
      instructor.organizationId,
      discordPersonId,
      { surface: 'web', externalId: removedPerson.accountId },
      testDb.db
    )
    if (!connected) throw new Error('test setup: connectIdentity refused')
    enrolments.endEnrolment(instructor.organizationId, enrolmentId, testDb.db)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .post(
        `/organizations/${instructor.organizationId}/actions/enrolments.reinstate`
      )
      .set('Cookie', removedPerson.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ enrolmentId })

    // ACT-3/TEN-5's not-found shape — refused not because this account
    // lacks a membership here (it genuinely holds one), but because
    // `reinstateEnrolmentAction.execute`'s own self-check finds the
    // caller's connected person is the exact person this enrolment names.
    expect(response.status).toBe(404)
    expect(
      enrolments.getEnrolment(instructor.organizationId, enrolmentId, testDb.db)
    ).toMatchObject({
      endedAt: expect.any(Number),
      reinstatedByAccountId: null,
      reinstatedAt: null,
    })
  })
})
