/**
 * WEB-10, over HTTP: the web chat surface. Every scenario here proves the
 * same properties `routes/chat.ts`'s own module comment describes —
 * ENRL-2's "a course a person is not enrolled in is refused as not
 * found," `answerQuestion` actually running (the fake model client records
 * every call it receives), and a signed-out caller reaching none of it.
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
import { FakeModelClient } from '../helpers/fake-model-client.js'
import { seedSignedInCaller, type SignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * A course this organization's bound Discord server could route to, plus —
 * for every test but the "not enrolled" one — an active enrolment admitting
 * `caller`'s own web person into it, via `enrolViaRoster` (ENRL-3): the same
 * "written through the real repos, never the surface under test" discipline
 * `helpers/seed.ts`'s own module comment already holds itself to. The
 * person enrolled is resolved exactly the way `routes/chat.ts` itself
 * resolves the caller — `people.resolvePersonByIdentity` on the `'web'`
 * surface, keyed on the account id — so the enrolment actually belongs to
 * whichever person the route under test will resolve.
 */
function seedEnrolledCourse(
  db: Database,
  caller: SignedInCaller,
  options: { enrol?: boolean } = {}
): { courseId: string } {
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

  if (options.enrol ?? true) {
    const person = people.resolvePersonByIdentity(
      caller.organizationId,
      { surface: 'web', externalId: caller.accountId },
      db
    )
    enrolments.enrolViaRoster(
      caller.organizationId,
      { courseId, personId: person.id },
      db
    )
  }

  return { courseId }
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

  it('lists only the courses this account is actively enrolled in', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, caller)
    // A second course this same account is not enrolled in — proves the
    // list is scoped to the enrolment, not to "every course in the
    // organization" (ENRL-2).
    seedEnrolledCourse(testDb.db, caller, { enrol: false })

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

  it('a fresh account, admitted nowhere yet, sees an empty course list', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(`/organizations/${caller.organizationId}/chat/courses`)
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(200)
    expect((response.body as { courses: unknown[] }).courses).toEqual([])
  })

  it('asking a course this account is not enrolled in is refused as not found (ENRL-2)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, caller, {
      enrol: false,
    })

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

  it('asks a question through the exact same answerQuestion pipeline, and the reply is on the transcript afterward', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, caller)
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
    const { courseId } = seedEnrolledCourse(testDb.db, caller)
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

  it('a model that rejects (e.g. OPENAI_API_KEY unset — apps/api/src/index.ts#createUnconfiguredModelClient) apologizes rather than 500ing', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId } = seedEnrolledCourse(testDb.db, caller)
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
