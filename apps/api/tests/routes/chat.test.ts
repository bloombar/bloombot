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
 *
 * `seedEnrolledCourse` takes no flag overrides — every course it creates
 * keeps `courses.createCourse`'s own real defaults (`answerUnenrolled:
 * true` among them), so a course's real defaults are exactly what every
 * "connected, no membership, refused" scenario below is tested against
 * (`routes/chat.ts`'s own predicate reads `selfEnrolFromDiscord`/
 * `answerUnenrolled` only for a caller who also holds a membership —
 * `enrolments.ts`'s own module comment on `ChatAdmission` has why). The
 * two tests specifically about ENRL-2's own enrolment scoping, unrelated
 * to membership, pin `answerUnenrolled: false` on their own second course
 * explicitly, with a comment saying why — everywhere else stays at the
 * real default.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

import type { ModelAnswer, ModelClient, ModelRequest } from '@bloombot/core'
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
  options: {
    enrol?: boolean
    // Overrides `createCourse`'s own real defaults — only the tests
    // specifically about ENRL-2's own enrolment scoping, or about one of
    // ENRL-16's own two settings, use these, with a comment saying why.
    answerUnenrolled?: boolean
    selfEnrolFromDiscord?: boolean
  } = {}
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
      enabled: true,
      adminsRole: `Staff-${unique}`,
      studentsRole: `Students-${unique}`,
      promptId: 'prompt-1',
      categories: [],
      ...(options.answerUnenrolled !== undefined
        ? { answerUnenrolled: options.answerUnenrolled }
        : {}),
      ...(options.selfEnrolFromDiscord !== undefined
        ? { selfEnrolFromDiscord: options.selfEnrolFromDiscord }
        : {}),
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

/**
 * ENRL-15 — a caller connected to a brand-new person with no enrolment
 * anywhere: the shape every scenario below that is *not* about ENRL-2's
 * own enrolled-person path needs (`connectCallerTo` above always connects
 * onto a caller-supplied `personId`; this is the "there is nothing else
 * to name" case).
 */
function connectCallerToFreshPerson(
  db: Database,
  caller: SignedInCaller
): string {
  const person = people.createPerson(caller.organizationId, {}, db)
  connectCallerTo(db, caller, person.id)
  return person.id
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
    // ENRL-15 gives this organization's own `owner` blanket admission to
    // every one of its courses, and ENRL-16 now admits any *member* through
    // a course's own settings (this file's own module comment) — a plain
    // `instructor` membership here, with the second course's own
    // `answerUnenrolled` pinned off below, so this stays a test of ENRL-2's
    // own enrolment scoping specifically.
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    // A second course the same discord-surface person is *not* enrolled
    // in — `answerUnenrolled: false` so this caller's own `instructor`
    // membership does not also admit them to it through ENRL-16's new
    // rule, which would defeat what this test is about.
    seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
      answerUnenrolled: false,
    })

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
    // Not this organization's `owner`, and `answerUnenrolled` pinned off —
    // see the identical note on the list test above; either ENRL-15's
    // owner rule or ENRL-16's new membership rule would otherwise admit
    // this caller regardless of enrolment, defeating what this test is
    // about.
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId, discordPersonId } = seedEnrolledCourse(
      testDb.db,
      caller,
      {
        enrol: false,
        answerUnenrolled: false,
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

  // CORE-7/CORE-8 — this route's own `addressPersonForWeb` (`routes/chat.ts`)
  // is the surface's own decision, exercised here through the real router
  // rather than a unit test of a private function this file cannot import:
  // a first name wins when the account has one, a display name is the
  // fallback, and neither ever falls back to this platform's own person id
  // — `model.calls` is an intermediate value (`@bloombot/core#answer.ts`'s
  // own `ModelRequest`), legitimate here because this test is about *which*
  // fact wins, not about what a student ultimately reads (that is
  // `answer.test.ts`'s own "reply text a student sees" regression, one
  // layer down).
  it('addresses a connected caller by first name, falling back to display name, then to nobody — never an id (CORE-7, CORE-8)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    people.overwriteRosterFields(
      caller.organizationId,
      discordPersonId,
      { firstName: 'Ada', displayName: 'Ada L.' },
      testDb.db
    )
    const model = new FakeModelClient('ok')

    const app = await buildTestApp(testDb.db, { model })
    const firstNameResponse = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'When is the midterm?' })
    expect(firstNameResponse.status).toBe(200)
    expect(model.calls[0]?.addressAs).toBe('Ada')

    // No first name — the display name is next in CORE-8's own order.
    people.overwriteRosterFields(
      caller.organizationId,
      discordPersonId,
      { firstName: null, displayName: 'Ada L.' },
      testDb.db
    )
    await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'When is the midterm?' })
    expect(model.calls[1]?.addressAs).toBe('Ada L.')

    // Neither known — CORE-8's own last resort: nobody, never this
    // platform's own person id, even though `discordPersonId` is right
    // here and would otherwise be the easiest thing to reach for.
    people.overwriteRosterFields(
      caller.organizationId,
      discordPersonId,
      { firstName: null, displayName: null },
      testDb.db
    )
    await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'When is the midterm?' })
    expect(model.calls[2]?.addressAs).toBeNull()
    expect(model.calls[2]?.addressAs).not.toBe(discordPersonId)
  })

  /**
   * CORE-7/CORE-8, over HTTP — the reported defect, reproduced and proven
   * fixed against the exact response body a browser reads, not an
   * intermediate value. Rework, found in review: `e2e/chat.spec.ts`'s own
   * two assertions on this look like they pin the fix but do not —
   * `e2e/support/fake-model-client.ts` is a static fixture that ignores
   * `request.addressAs` entirely, so those assertions pass with the defect
   * fully present (confirmed: reverting `answer.ts`'s `addressAs`
   * computation and rerunning that spec still passes). This test is the
   * cheaper, genuine proof at the HTTP layer this app's own test suite can
   * give — an `EchoingModelClient` that behaves the way a course prompt
   * written for Discord actually does (addresses the reader at the front of
   * its own reply, the same mechanism `packages/core/tests/answer.test.ts`'s
   * own CORE-7/CORE-8 block uses one layer down).
   */
  class EchoingModelClient implements ModelClient {
    calls: ModelRequest[] = []
    async ask(request: ModelRequest): Promise<ModelAnswer> {
      this.calls.push(request)
      const prefix = request.addressAs ? `${request.addressAs} - ` : ''
      return { text: `${prefix}Hello`, upstreamThreadId: null, model: 'echo' }
    }
  }

  it('a web reply contains no mention token and no raw account id, in the HTTP response body a student actually receives (CORE-7, CORE-8)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)
    const model = new EchoingModelClient()

    const app = await buildTestApp(testDb.db, { model })
    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'When is the midterm?' })

    expect(response.status).toBe(200)
    const body = response.body as { result: { text: string } }
    expect(body.result.text).toBe('Hello')
    expect(body.result.text).not.toContain('<@')
    expect(body.result.text).not.toContain(caller.accountId)
    expect(body.result.text).not.toContain(discordPersonId)
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

    // A first question is recorded — but not at a magnitude this test can
    // claim. Rework finding (a review of this slice caught it): the comment
    // here used to say "costs something real … never 0 (COST-6)", which is
    // false in this harness specifically — `buildTestApp`
    // (`apps/api/tests/helpers/build-test-app.ts`) wires no `pricing`
    // either, so `answerQuestion` falls through to its own
    // `NO_PRICING_CONFIGURED` fallback (`@bloombot/core#answer.ts`, an
    // all-zero rate table) and this call is genuinely priced at `costMicros:
    // 0`. What this test actually proves is COST-3's own `spent >= cap`
    // boundary at its edge (`0 >= 0`, below) — the same boundary a cap of
    // `0` fires against with no spend recorded at all — not that a real
    // magnitude was priced; that end-to-end claim belongs to (and is
    // exercised by) `e2e/usage-panel.spec.ts` instead, which reads a
    // genuinely nonzero `cost_micros` back from a real pricing table.
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

  // ENRL-15 — the first reported problem: the account that creates a
  // course, its own organization's `owner` (`seedSignedInCaller`'s own
  // default role), held no enrolment in it and so could not chat in it at
  // all. `seedEnrolledCourse` defaults to `enrol: true`, so this
  // deliberately opts out to prove the *owner* path admits on its own.
  it("ENRL-15: this organization's owner sees, reads and posts in a course they created but never enrolled in", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
    })
    connectCallerToFreshPerson(testDb.db, caller)
    const model = new FakeModelClient('Welcome, owner.')

    const app = await buildTestApp(testDb.db, { model })

    const list = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)
    expect(list.status).toBe(200)
    expect(
      (list.body as { courses: { id: string }[] }).courses.map((c) => c.id)
    ).toEqual([courseId])

    const read = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(read.status).toBe(200)

    const post = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(post.status).toBe(200)
    expect((post.body as { result: { kind: string } }).result.kind).toBe(
      'answered'
    )
    expect(model.calls).toHaveLength(1)
  })

  // ENRL-16, the reported bug finally closed as a side effect: an
  // instructor is a member of the organization the course they created
  // belongs to, so a course left at `createCourse`'s own real default
  // (`answerUnenrolled: true`) admits them even though they hold no
  // enrolment and are not the organization's `owner`.
  it('ENRL-16: a plain member (not the owner, no enrolment) sees, reads and posts in a default-settings course', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId } = seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
    })
    connectCallerToFreshPerson(testDb.db, caller)
    const model = new FakeModelClient('Sure, ask away.')

    const app = await buildTestApp(testDb.db, { model })

    const list = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)
    expect(
      (list.body as { courses: { id: string }[] }).courses.map((c) => c.id)
    ).toEqual([courseId])

    const read = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(read.status).toBe(200)

    const post = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(post.status).toBe(200)
    expect((post.body as { result: { kind: string } }).result.kind).toBe(
      'answered'
    )
  })

  // The same member, refused on a course carrying neither setting —
  // membership alone is not ambient admission; it only ever unlocks a
  // course's own settings (this file's own module comment).
  it('ENRL-16: the same plain member is refused on a course carrying neither setting', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId } = seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
      answerUnenrolled: false,
    })
    connectCallerToFreshPerson(testDb.db, caller)

    const app = await buildTestApp(testDb.db)

    const list = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)
    expect((list.body as { courses: unknown[] }).courses).toEqual([])

    const read = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(read.status).toBe(404)

    const write = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(write.status).toBe(404)
  })

  // Must-fix 1 from a review round, re-aimed at the caller it actually
  // targets: a signed-in *stranger to this organization* — their own
  // account belongs to a different organization entirely, and the only
  // thing they have done here is complete an ordinary connect flow
  // (`routes/person-link.ts`'s own `/discord/begin` requires nothing more
  // than a session and an organization id that exists — no membership, no
  // enrolment; this is that same shape, reproduced directly against
  // `people.connectIdentity` rather than the real OAuth round trip). Must
  // not be admitted, even on a course left at `createCourse`'s own real
  // default — the no-leak regression test that matters most.
  it('a signed-in stranger with a connected person, but no membership and no enrolment, cannot list, read or post in a default-settings course (must-fix 1, no-leak)', async () => {
    testDb = createTestDatabase()
    const owner = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, owner, {
      enrol: false,
    })
    // A stranger to `owner`'s own organization — their own account was
    // created elsewhere (a personal organization of their own, with no
    // membership at all in `owner`'s), and the only thing they have done
    // in `owner`'s organization is connect a person there.
    const stranger = seedSignedInCaller(testDb.db, {
      organizationName: "The stranger's own personal organization",
    })
    const strangerPerson = people.createPerson(
      owner.organizationId,
      {},
      testDb.db
    )
    const connected = people.connectIdentity(
      owner.organizationId,
      strangerPerson.id,
      { surface: 'web', externalId: stranger.accountId },
      testDb.db
    )
    if (!connected) throw new Error('test setup: connectIdentity refused')

    const app = await buildTestApp(testDb.db)

    const list = await request(app)
      .get(`/organizations/${owner.organizationId}/chat/courses`)
      .set('Cookie', stranger.cookieHeader)
    expect(list.status).toBe(200)
    expect((list.body as { courses: unknown[] }).courses).toEqual([])

    const read = await request(app)
      .get(
        `/organizations/${owner.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', stranger.cookieHeader)
    expect(read.status).toBe(404)

    const write = await request(app)
      .post(
        `/organizations/${owner.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', stranger.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(write.status).toBe(404)
  })

  // Must-fix 2, reproduced then proven fixed: an instructor ending a
  // student's enrolment must actually stop them, on a course left at
  // `createCourse`'s own real, default settings — the caller's own
  // `instructor` membership must not readmit them through the course's
  // settings once their enrolment has been ended.
  it('an ended enrolment refuses on every path, on a default-settings course, matching handle-mention.ts (ENRL-6/ENRL-9, must-fix 2)', async () => {
    testDb = createTestDatabase()
    // Not this organization's `owner` — ENRL-15's owner rule would
    // otherwise admit this caller regardless of their own enrolment
    // ending, defeating what this test is about.
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, caller)
    connectCallerTo(testDb.db, caller, discordPersonId)

    const app = await buildTestApp(testDb.db)

    // Baseline: the connected, actively-enrolled caller can ask.
    const before = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(before.status).toBe(200)

    const enrolment = enrolments.getActiveEnrolment(
      caller.organizationId,
      courseId,
      discordPersonId,
      testDb.db
    )
    if (!enrolment) throw new Error('test setup: no active enrolment')
    enrolments.endEnrolment(caller.organizationId, enrolment.id, testDb.db)

    const list = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)
    expect((list.body as { courses: unknown[] }).courses).toEqual([])

    const read = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(read.status).toBe(404)

    const write = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(write.status).toBe(404)
  })

  // The order this pins, over HTTP: an instructor ends the organization
  // owner's own enrolment in a course. `admissionForCourse`
  // (`repos/enrolments.ts`) used to check `isOwner` ahead of
  // `hasEndedEnrolment`, which kept the course listed and answering for
  // the owner regardless — the one mutation (of eight planted) that
  // survived this suite. ENRL-6 is an instructor's deliberate act; an
  // owner can reinstate it (ENRL-9) if they disagree, not have it
  // silently overridden by holding the organization's own top role.
  it("ENRL-6/ENRL-9: an ended enrolment refuses the organization's own owner too, even though owner otherwise admits unconditionally", async () => {
    testDb = createTestDatabase()
    const owner = seedSignedInCaller(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(testDb.db, owner)
    connectCallerTo(testDb.db, owner, discordPersonId)

    const app = await buildTestApp(testDb.db)

    const before = await request(app)
      .get(
        `/organizations/${owner.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', owner.cookieHeader)
    expect(before.status).toBe(200)

    const enrolment = enrolments.getActiveEnrolment(
      owner.organizationId,
      courseId,
      discordPersonId,
      testDb.db
    )
    if (!enrolment) throw new Error('test setup: no active enrolment')
    enrolments.endEnrolment(owner.organizationId, enrolment.id, testDb.db)

    const list = await request(app)
      .get(`/organizations/${owner.organizationId}/chat/courses`)
      .set('Cookie', owner.cookieHeader)
    expect((list.body as { courses: unknown[] }).courses).toEqual([])

    const read = await request(app)
      .get(
        `/organizations/${owner.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', owner.cookieHeader)
    expect(read.status).toBe(404)

    const write = await request(app)
      .post(
        `/organizations/${owner.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', owner.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(write.status).toBe(404)
  })

  // The identical must-fix 2 shape, on a course carrying
  // `selfEnrolFromDiscord` — proving the ended-enrolment refusal holds
  // ahead of ENRL-16's own settings-based admission too, not merely ahead
  // of `answerUnenrolled`.
  it('an ended enrolment refuses on every path, on a course carrying selfEnrolFromDiscord', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const project = projects.createProject(
      caller.organizationId,
      { name: `Term ${randomUUID()}` },
      testDb.db
    )
    const unique = randomUUID()
    const created = courses.createCourse(
      caller.organizationId,
      {
        projectId: project.id,
        title: 'Self-Enrolling Course',
        enabled: true,
        adminsRole: `Staff-${unique}`,
        studentsRole: `Students-${unique}`,
        categories: [],
        selfEnrolFromDiscord: true,
      },
      testDb.db
    )
    if (!created.ok) throw new Error('test setup: course creation refused')
    const courseId = created.course.id
    const discordPerson = people.resolvePersonByIdentity(
      caller.organizationId,
      { surface: 'discord', externalId: `discord-user-${randomUUID()}` },
      testDb.db
    )
    const enrolment = enrolments.enrolViaRoster(
      caller.organizationId,
      { courseId, personId: discordPerson.id },
      testDb.db
    )
    if (!enrolment) throw new Error('test setup: no enrolment')
    connectCallerTo(testDb.db, caller, discordPerson.id)
    enrolments.endEnrolment(caller.organizationId, enrolment.id, testDb.db)

    const app = await buildTestApp(testDb.db)

    const read = await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(read.status).toBe(404)

    const write = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(write.status).toBe(404)
  })

  // ENRL-16's own judgement call, restored and pinned explicitly: a
  // message under `selfEnrolFromDiscord`, by a member with no prior
  // enrolment, enrols the caller on this very message — the same
  // `source: 'self_enrolment'` `@bloombot/discord`'s `handle-mention.ts`
  // writes for an already-connected person.
  it('ENRL-16: a POST under selfEnrolFromDiscord by a member creates an enrolment with the same source Discord writes', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId } = seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
      answerUnenrolled: false,
      selfEnrolFromDiscord: true,
    })
    const personId = connectCallerToFreshPerson(testDb.db, caller)
    const model = new FakeModelClient('Welcome aboard.')

    const app = await buildTestApp(testDb.db, { model })

    // Reading before ever asking anything does not enrol — a `GET` must
    // never write.
    await request(app)
      .get(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
    expect(
      enrolments.getActiveEnrolment(
        caller.organizationId,
        courseId,
        personId,
        testDb.db
      )
    ).toBeUndefined()

    const post = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })
    expect(post.status).toBe(200)
    expect((post.body as { result: { kind: string } }).result.kind).toBe(
      'answered'
    )

    const enrolment = enrolments.getActiveEnrolment(
      caller.organizationId,
      courseId,
      personId,
      testDb.db
    )
    expect(enrolment).toBeDefined()
    expect(enrolment?.source).toBe('self_enrolment')
  })

  // The bug this file's own module comment describes chat.ts fixing: a
  // review round caught the first version of this write discarding its
  // own return value. Reproduced with `vi.spyOn` on the exported repo
  // function, standing in for the race `routes/chat.ts`'s own comment
  // describes (`resolveChatAdmission` and this write reading the same row
  // set microseconds apart) — a real race is not reproducible
  // deterministically in a single-threaded test, but the *consequence* of
  // a decline reaching this code path is exactly what this pins.
  it('ENRL-16: a POST under selfEnrolFromDiscord is refused, not answered, when the enrolment write declines', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId } = seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
      answerUnenrolled: false,
      selfEnrolFromDiscord: true,
    })
    connectCallerToFreshPerson(testDb.db, caller)
    const model = new FakeModelClient('unused')

    const spy = vi
      .spyOn(enrolments, 'enrolViaSelfEnrolment')
      .mockReturnValue(undefined)

    const app = await buildTestApp(testDb.db, { model })
    const post = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })

    spy.mockRestore()

    expect(post.status).toBe(404)
    expect((post.body as { error: string }).error).toBe('chat_course_not_found')
    expect(model.calls).toHaveLength(0)
  })

  // A thrown error recording the admission (an unexpected database
  // failure, not the ordinary decline the test above pins) is logged and
  // does not block the reply — the identical "does not block the reply"
  // treatment `handle-mention.ts`'s own admission write already gives its
  // own failure.
  it('ENRL-16: a POST under selfEnrolFromDiscord still answers when the enrolment write throws, logging rather than 500ing', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db, { role: 'instructor' })
    const { courseId } = seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
      answerUnenrolled: false,
      selfEnrolFromDiscord: true,
    })
    connectCallerToFreshPerson(testDb.db, caller)
    const model = new FakeModelClient('Welcome aboard.')

    const spy = vi
      .spyOn(enrolments, 'enrolViaSelfEnrolment')
      .mockImplementation(() => {
        throw new Error('simulated database failure')
      })

    const app = await buildTestApp(testDb.db, { model })
    const post = await request(app)
      .post(
        `/organizations/${caller.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ text: 'Anybody there?' })

    spy.mockRestore()

    expect(post.status).toBe(200)
    expect((post.body as { result: { kind: string } }).result.kind).toBe(
      'answered'
    )
  })

  // ENRL-15/16 — the invariant most likely to break: whatever `GET
  // /courses` lists, the same caller's own per-course read must also
  // succeed against. One organization, four courses in four different
  // admission states (enrolled, owner-admitted, member-admitted through
  // settings, refused), asked by the same non-owner member caller.
  it('ENRL-15/16: every course the list offers is one whose messages the same caller may read', async () => {
    testDb = createTestDatabase()
    const owner = seedSignedInCaller(testDb.db)
    connectCallerToFreshPerson(testDb.db, owner)
    const member = seedSecondCallerInOrganization(
      testDb.db,
      owner.organizationId
    )
    const personId = connectCallerToFreshPerson(testDb.db, member)

    const enrolledCourse = seedEnrolledCourse(testDb.db, owner, {
      enrol: false,
      answerUnenrolled: false,
    })
    const enrolled = enrolments.enrolViaRoster(
      owner.organizationId,
      { courseId: enrolledCourse.courseId, personId },
      testDb.db
    )
    if (!enrolled) throw new Error('test setup: enrolment refused')

    const memberAdmittedCourse = seedEnrolledCourse(testDb.db, owner, {
      enrol: false,
    })
    const refusedCourse = seedEnrolledCourse(testDb.db, owner, {
      enrol: false,
      answerUnenrolled: false,
    })

    const app = await buildTestApp(testDb.db)

    const memberList = await request(app)
      .get(`/organizations/${member.organizationId}/chat/courses`)
      .set('Cookie', member.cookieHeader)
    const memberListedIds = (
      memberList.body as { courses: { id: string }[] }
    ).courses
      .map((c) => c.id)
      .sort()
    expect(memberListedIds).toEqual(
      [enrolledCourse.courseId, memberAdmittedCourse.courseId].sort()
    )
    expect(memberListedIds).not.toContain(refusedCourse.courseId)

    for (const courseId of memberListedIds) {
      const memberRead = await request(app)
        .get(
          `/organizations/${member.organizationId}/chat/courses/${courseId}/messages`
        )
        .set('Cookie', member.cookieHeader)
      expect(memberRead.status).toBe(200)
    }

    const memberRefusedRead = await request(app)
      .get(
        `/organizations/${member.organizationId}/chat/courses/${refusedCourse.courseId}/messages`
      )
      .set('Cookie', member.cookieHeader)
    expect(memberRefusedRead.status).toBe(404)

    // The owner's own list: every enabled course in the organization,
    // including the one they hold no enrolment in and no course-level
    // membership admission for — and every one of them is also readable.
    const ownerList = await request(app)
      .get(`/organizations/${owner.organizationId}/chat/courses`)
      .set('Cookie', owner.cookieHeader)
    const ownerListedIds = (
      ownerList.body as { courses: { id: string }[] }
    ).courses
      .map((c) => c.id)
      .sort()
    expect(ownerListedIds).toEqual(
      [
        enrolledCourse.courseId,
        memberAdmittedCourse.courseId,
        refusedCourse.courseId,
      ].sort()
    )
    for (const courseId of ownerListedIds) {
      const ownerRead = await request(app)
        .get(
          `/organizations/${owner.organizationId}/chat/courses/${courseId}/messages`
        )
        .set('Cookie', owner.cookieHeader)
      expect(ownerRead.status).toBe(200)
    }
  })

  // An unconnected account is refused as not-connected regardless of what
  // a course's own settings carry — the same as it always has been (this
  // file's own earlier "no connected person" tests, above). Not creating a
  // person as a side effect of this check is `routes/chat.ts`'s own
  // `resolveIdentity` discipline (its module comment).
  it('an account with no connected person is refused as not-connected, on a default-settings course, regardless of any relationship it might otherwise have', async () => {
    testDb = createTestDatabase()
    const owner = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, owner, {
      enrol: false,
    })
    const member = seedSecondCallerInOrganization(
      testDb.db,
      owner.organizationId
    )
    // Deliberately no `connectCallerToFreshPerson` call here.

    const app = await buildTestApp(testDb.db)

    const list = await request(app)
      .get(`/organizations/${member.organizationId}/chat/courses`)
      .set('Cookie', member.cookieHeader)
    expect(list.status).toBe(404)
    expect((list.body as { error: string }).error).toBe('chat_not_connected')

    const read = await request(app)
      .get(
        `/organizations/${member.organizationId}/chat/courses/${courseId}/messages`
      )
      .set('Cookie', member.cookieHeader)
    expect(read.status).toBe(404)
    expect((read.body as { error: string }).error).toBe('chat_not_connected')
  })
})
