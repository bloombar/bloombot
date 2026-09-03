/**
 * ENRL-9, over HTTP: `enrolments.reinstate`, proven the way access to a
 * course actually matters — through `routes/chat.ts`, which authorizes on
 * an *active* enrolment (`enrolments.getActiveEnrolment`), not merely
 * `endedAt` on the row — and proven that the reinstated person cannot
 * trigger this themselves. That second guarantee is the whole distinction
 * the ENRL-8 rework turns on (`actions/enrolments.ts`'s own module comment
 * on `reinstateEnrolmentAction`): holding the connected identity of the
 * ended person is not a membership, and `routes/actions.ts` resolves the
 * caller's organization from a membership alone, before `dispatch` ever
 * runs — so an account that is only ever this course's *student* cannot
 * reach `enrolments.reinstate` at all, regardless of what its own policy
 * would otherwise allow.
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
    // The student's own web account — connected to the enrolled person, the
    // same "signed in, proven by connecting" shape `routes/chat.ts`'s own
    // module comment describes for a real student.
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

  it('the removed person cannot reinstate their own enrolment — their connected account holds no membership here', async () => {
    testDb = createTestDatabase()
    const instructor = seedSignedInCaller(testDb.db)
    const { discordPersonId, enrolmentId } = seedEnrolledCourse(
      testDb.db,
      instructor
    )
    // A signed-in account of its own, in a *different* organization — the
    // same "own account, own membership, elsewhere" shape a real student's
    // web sign-in produces (`seedSignedInCaller` mints a fresh organization
    // per call, so this account's only membership is there, never in
    // `instructor.organizationId`).
    const removedPerson = seedSignedInCaller(testDb.db)
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

    // ACT-3/TEN-5: refused the same not-found shape a foreign session gets
    // against any other action — this account genuinely has no membership
    // in `instructor.organizationId`, connected identity or not.
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
