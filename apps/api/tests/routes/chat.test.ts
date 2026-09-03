/**
 * WEB-10, over HTTP: the web chat surface. Every scenario here proves the
 * same properties `routes/chat.ts`'s own module comment describes — a
 * signed-in web caller resolves *only* to a person it is already connected
 * to (never one this route creates), ENRL-2's "a course a person is not
 * enrolled in is refused as not found," `answerQuestion` actually running
 * (the fake model client records every call it receives), and a
 * signed-out caller reaching none of it.
 *
 * `seedEnrolledCourse` admits its person the way production actually does
 * — a `discord`-surface identity, via `enrolViaRoster` — never the caller's
 * own web identity: seeding the enrolment against a web person (this
 * file's own former mistake) made every reachability assertion tautological
 * about the exact bug this rework fixes. `connectCallerTo` is the separate,
 * explicit step that simulates a connect flow having already run, through
 * the real `people.connectIdentity` (LINK-3's own merged path) — never a
 * raw `connectedAt` write.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import {
  conversations,
  courses,
  enrolments,
  organizations,
  people,
  projects,
  type Database,
} from '@bloombot/db'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { FakeModelClient } from '../helpers/fake-model-client.js'
import { seedSignedInCaller, type SignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * A course this organization's bound Discord server could route to, with an
 * active enrolment admitting a `discord`-surface person into it via
 * `enrolViaRoster` — the same admission path a real roster import uses
 * (`apps/worker`'s own `roster-import.ts`), and the *only* kind of person
 * any real enrolment in this system ever belongs to (this file's own module
 * comment). Returns that person's id, never `caller`'s own — connecting the
 * two, when a scenario needs that, is `connectCallerTo`'s own explicit job.
 */
function seedEnrolledCourse(
  db: Database,
  caller: SignedInCaller,
  options: { enrol?: boolean } = {}
): { courseId: string; discordPersonId: string } {
  // A fresh project name per call — this app's own PROJ-1 constraint is
  // unique per organization, and this helper is called more than once for
  // the same organization in a handful of these tests (a second, unenrolled
  // course to prove ENRL-2's own scoping).
  const project = projects.createProject(
    caller.organizationId,
    { name: `Term ${randomUUID()}` },
    db
  )
  // PROJ-3: a course's role names are unique across every *enabled* course
  // in the organization — a fresh pair per call, for the same reason the
  // project name above is fresh per call.
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
  const courseId = created.course.id

  const discordPerson = people.resolvePersonByIdentity(
    caller.organizationId,
    { surface: 'discord', externalId: `discord-user-${randomUUID()}` },
    db
  )
  if (options.enrol ?? true) {
    enrolments.enrolViaRoster(
      caller.organizationId,
      { courseId, personId: discordPerson.id },
      db
    )
  }

  return { courseId, discordPersonId: discordPerson.id }
}

/**
 * Connects `caller`'s own web identity onto `personId` — the real
 * `people.connectIdentity` (LINK-3's merged path), standing in here for
 * whatever future connect/join-link flow would do this for a real student;
 * see `routes/chat.ts`'s own module comment for what today's chat surface
 * does and does not make reachable without it.
 */
function connectCallerTo(
  db: Database,
  caller: SignedInCaller,
  personId: string
): void {
  const connected = people.connectIdentity(
    caller.organizationId,
    personId,
    { surface: 'web', externalId: caller.accountId },
    db
  )
  if (!connected) throw new Error('test setup: connectIdentity refused')
}

describe('routes/chat.ts (WEB-10)', () => {
  it('a signed-out caller reaches none of it', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const response = await request(app).get(
      '/organizations/some-org/chat/courses'
    )
    expect(response.status).toBe(401)
    expect((response.body as { error: string }).error).toBe('not_signed_in')
  })

  // WEB-10 rework, finding 1 — the regression this whole file exists to
  // catch: before the rework, this router resolved the caller with
  // `people.resolvePersonByIdentity` (create on demand), which can never
  // find a real enrolment — every one belongs to a `discord`-surface person
  // (`seedEnrolledCourse`'s own module comment) — so `GET .../chat/courses`
  // returned `{courses: []}` for every real student, forever, no matter
  // what an instructor configured. This seeds the enrolment the way
  // production actually creates one and proves the *unconnected* case is
  // now an honest, distinct refusal — not a silently empty list that reads
  // as "you are not enrolled" when the real problem is "nobody has ever
  // connected this account to that enrolment."
  it('a signed-in account with no connected person in this organization is refused as not-connected, not shown an empty list', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    seedEnrolledCourse(testDb.db, caller)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(404)
    expect((response.body as { error: string }).error).toBe(
      'chat_not_connected'
    )
  })

  it('once genuinely connected to the enrolled (discord-surface) person, the same course is reachable', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(200)
    const body = response.body as { courses: { id: string; title: string }[] }
    expect(body.courses).toHaveLength(1)
    expect(body.courses[0]?.id).toBe(courseId)
    expect(body.courses[0]?.title).toBe('Intro to Testing')
  })

  it('lists only the courses this connected person is actively enrolled in — a second course this same person is not enrolled in never appears', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    // A second course the same discord-surface person is *not* enrolled in.
    seedEnrolledCourse(testDb.db, caller, { enrol: false })

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(200)
    const body = response.body as { courses: { id: string }[] }
    expect(body.courses).toHaveLength(1)
    expect(body.courses[0]?.id).toBe(courseId)
  })

  // WEB-10 rework, finding 2 — one person, one allowance (LINK-5). Before
  // the rework, every chat visit resolved (and, the first time, created) a
  // *second*, web-surface person distinct from the discord-surface one an
  // enrolment actually belongs to — two person rows, two usage counters,
  // two transcripts, in the same organization, for the same human. Once
  // connected the real way, exactly one person answers to this account.
  it('does not create a second person or a second allowance for an already-connected caller', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)

    const beforeCount = people.listPeople(
      caller.organizationId,
      testDb.db
    ).length

    const app = await buildTestApp(testDb.db)
    await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)

    const afterCount = people.listPeople(
      caller.organizationId,
      testDb.db
    ).length
    expect(afterCount).toBe(beforeCount)
  })

  // WEB-10 rework, finding 3 — TEN-5: a foreign or nonexistent organization
  // is refused the identical way, and never written to. Before the rework,
  // `resolvePersonByIdentity` inserted a `people` row into whatever
  // organization the URL named, before anything checked the caller had any
  // relationship to it at all — reachable by any signed-in account against
  // any other tenant's organization id, and a nonexistent id produced a raw
  // foreign-key `500` (an existence oracle) rather than the same `404`.
  it('a caller with no relationship to a foreign organization is refused, and nothing is written to it', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const victimOrganizationId = randomUUID()
    organizations.createOrganization(
      victimOrganizationId,
      { name: 'Victim Org', isPersonal: false },
      testDb.db
    )
    const beforeCount = people.listPeople(
      victimOrganizationId,
      testDb.db
    ).length

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(`/organizations/${victimOrganizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(404)
    expect((response.body as { error: string }).error).toBe(
      'chat_not_connected'
    )
    expect(people.listPeople(victimOrganizationId, testDb.db)).toHaveLength(
      beforeCount
    )
  })

  it('a nonexistent organization is refused the identical way a real, foreign one is — not a 500, and no existence oracle', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(`/organizations/${randomUUID()}/chat/courses`)
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(404)
    expect((response.body as { error: string }).error).toBe(
      'chat_not_connected'
    )
  })

  it('asking a course this connected person is not enrolled in is refused as not found (ENRL-2)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(
      testDb.db,
      caller,
      {
        enrol: false,
      }
    )
    connectCallerTo(testDb.db, caller, discordPersonId)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'What is on the syllabus?' })

    expect(response.status).toBe(404)
    expect((response.body as { error: string }).error).toBe(
      'chat_course_not_found'
    )
  })

  it('an unconnected caller posting a message is refused as not-connected, before the model is ever asked', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, caller)
    const model = new FakeModelClient('unused')

    const app = await buildTestApp(testDb.db, { model })
    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })

    expect(response.status).toBe(404)
    expect((response.body as { error: string }).error).toBe(
      'chat_not_connected'
    )
    expect(model.calls).toHaveLength(0)
  })

  // WEB-10 rework, finding 3 — this route must not write. Reproduced: a
  // fresh course this connected person has never asked anything in yet had
  // zero `conversations` rows before this GET, and (before the fix) one
  // afterward — `getOrCreateConversation` called to *read* a transcript
  // silently created one, breaking `middleware/origin.ts`'s own "a GET is
  // not supposed to change anything in the first place" for this one
  // route.
  it('GET .../messages never creates a conversation — reading an empty transcript is a read, not a write', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)

    expect(
      conversations.listConversationsForCourse(
        caller.organizationId,
        courseId,
        testDb.db
      )
    ).toHaveLength(0)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(200)
    expect((response.body as { messages: unknown[] }).messages).toEqual([])
    expect(
      conversations.listConversationsForCourse(
        caller.organizationId,
        courseId,
        testDb.db
      )
    ).toHaveLength(0)
  })

  it('asks a question through the exact same answerQuestion pipeline, and the reply is on the transcript afterward', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    const model = new FakeModelClient('# Welcome\n\nAsk away.')

    const app = await buildTestApp(testDb.db, { model })
    const post = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'What is on the syllabus?' })

    expect(post.status).toBe(200)
    const posted = post.body as { result: { kind: string; text: string } }
    expect(posted.result.kind).toBe('answered')
    expect(posted.result.text).toBe('# Welcome\n\nAsk away.')
    // The pipeline this route calls is `@bloombot/core#answerQuestion`
    // itself, not a stand-in for it — the fake model client is the only
    // fake in this test, and it recorded exactly one call.
    expect(model.calls).toHaveLength(1)

    const get = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(get.status).toBe(200)
    const transcript = (
      get.body as {
        messages: { role: string; text: string }[]
      }
    ).messages
    expect(transcript).toHaveLength(2)
    expect(transcript[0]).toMatchObject({
      role: 'student',
      text: 'What is on the syllabus?',
    })
    expect(transcript[1]).toMatchObject({
      role: 'assistant',
      text: '# Welcome\n\nAsk away.',
    })
  })

  it('an empty question is refused as invalid input before it ever reaches the model', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    const model = new FakeModelClient('unused')

    const app = await buildTestApp(testDb.db, { model })
    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: '' })

    expect(response.status).toBe(400)
    expect((response.body as { error: string }).error).toBe(
      'action_input_invalid'
    )
    expect(model.calls).toHaveLength(0)
  })

  // WEB-10 rework, finding 7 — bounded, not just non-empty. The allowance
  // counts requests, never characters, so an unbounded `text` is no real
  // spending bound at all.
  it('a question over the length ceiling is refused as invalid input before it ever reaches the model', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    const model = new FakeModelClient('unused')

    const app = await buildTestApp(testDb.db, { model })
    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'a'.repeat(4001) })

    expect(response.status).toBe(400)
    expect((response.body as { error: string }).error).toBe(
      'action_input_invalid'
    )
    expect(model.calls).toHaveLength(0)
  })

  it('a question at exactly the length ceiling is accepted', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    const model = new FakeModelClient('ok')

    const app = await buildTestApp(testDb.db, { model })
    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'a'.repeat(4000) })

    expect(response.status).toBe(200)
    expect(model.calls).toHaveLength(1)
  })

  // COST-3, end to end through this same pipeline — proves the cap is real,
  // not merely storable. Before `costLedger.setSpendingCap` existed,
  // `organizations.setSpendingCap` (`@bloombot/db`) had zero non-test
  // callers anywhere in the monorepo (`docs/ROADMAP.md`'s "Audit —
  // surfaces that were never built"): the enforcement below
  // (`hasReachedSpendingCap`, `@bloombot/core#answer.ts`) was always real,
  // but nothing could ever put a cap in front of it in a real deployment.
  // This dispatches the ordinary action route, unmodified — the same one
  // `pages/Usage.tsx` calls in the panel — and proves the very next
  // question over this route's own `answerQuestion` pipeline is refused,
  // never reaching the model a second time.
  it('a spending cap set through the action layer actually refuses the next question, over the same answerQuestion pipeline (COST-3)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    const model = new FakeModelClient('# Welcome\n\nAsk away.')

    const app = await buildTestApp(testDb.db, { model })

    // A first question costs something real: `FakeModelClient` reports no
    // token usage, so `computeCost` estimates and prices it from the
    // request/answer text's own length (`@bloombot/core`'s own
    // `pricing.ts`), never `0` (COST-6).
    const first = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'What is on the syllabus?' })
    expect(first.status).toBe(200)
    expect((first.body as { result: { kind: string } }).result.kind).toBe(
      'answered'
    )
    expect(model.calls).toHaveLength(1)

    // A cap of $0 — already reached the moment anything has been spent at
    // all (`hasReachedSpendingCap`'s own `spent >= cap`, and the question
    // above spent something real) — set through the ordinary action route,
    // exactly the way an owner reaches it from the panel.
    const setCap = await request(app)
      .post(
        `/organizations/${caller.organizationId}/actions/costLedger.setSpendingCap`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ capAmount: 0 })
    expect(setCap.status).toBe(200)

    // The next question is refused before the model is ever asked again —
    // `declined-over-cap`, not a generic failure (COST-3's own text) — and
    // the fake model client proves it: still exactly one call, not two.
    const second = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'What is on the syllabus?' })
    expect(second.status).toBe(200)
    expect((second.body as { result: { kind: string } }).result.kind).toBe(
      'declined-over-cap'
    )
    expect(model.calls).toHaveLength(1)
  })

  it('a model that rejects (e.g. OPENAI_API_KEY unset — apps/api/src/index.ts#createUnconfiguredModelClient) apologizes rather than 500ing', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    // `answerQuestion`'s own defined outcome for a model call that throws
    // (`packages/core/src/answer.ts`'s `failed-with-apology`) — this route
    // must pass that outcome straight through as an ordinary `200`, not let
    // it escape as an unhandled rejection `middleware/errors.ts` would turn
    // into a `500`.
    const model = { ask: () => Promise.reject(new Error('not configured')) }

    const app = await buildTestApp(testDb.db, { model })
    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })

    expect(response.status).toBe(200)
    const body = response.body as { result: { kind: string; text: string } }
    expect(body.result.kind).toBe('failed-with-apology')
    expect(body.result.text).toMatch(/sorry/i)
  })
})
