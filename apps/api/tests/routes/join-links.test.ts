/**
 * ENRL-8, over HTTP: `POST /join-links/redeem` — a course join link,
 * redeemed bound to the caller's own signed-in session, never a
 * request-body-supplied identity.
 *
 * `seedJoinLink` writes the link directly through `@bloombot/db`'s own
 * `courseJoinLinks.createJoinLink`, hashing a known plaintext with the same
 * SHA-256-over-the-raw-string algorithm `@bloombot/actions`' (module-private)
 * `hashSecret` uses — `createCourseJoinLinkAction` is not part of
 * `@bloombot/actions`' own public root export (only `createPlatformRegistry`
 * bundles it, for `routes/actions.ts`'s dispatcher), so this file cannot
 * import it directly; `packages/db/tests/course-join-links.test.ts` already
 * establishes this same "known plaintext, hash it the same way" pattern for
 * exactly this reason.
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  courseJoinLinks,
  courses,
  enrolments,
  people,
  projects,
  type Database,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller, type SignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** The same hash `@bloombot/actions`' own (module-private) `hashSecret` computes — see this file's own module comment. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** One enabled course in `issuer`'s own organization, and a live join link for it. */
function seedJoinLink(
  db: Database,
  issuer: SignedInCaller,
  options: { secret?: string; expiresAt?: number | null } = {}
): { courseId: string; secret: string; linkId: string } {
  const project = projects.createProject(
    issuer.organizationId,
    { name: `Term ${randomUUID()}` },
    db
  )
  const unique = randomUUID()
  const created = courses.createCourse(
    issuer.organizationId,
    {
      projectId: project.id,
      title: 'Intro to Testing',
      filePrefix: 'testing',
      enabled: true,
      adminsRole: `Staff-${unique}`,
      studentsRole: `Students-${unique}`,
      categories: [],
    },
    db
  )
  if (!created.ok) throw new Error('test setup: course creation refused')

  const secret = options.secret ?? `secret-${randomUUID()}`
  const link = courseJoinLinks.createJoinLink(
    issuer.organizationId,
    {
      courseId: created.course.id,
      secretHash: hashSecret(secret),
      expiresAt: options.expiresAt ?? null,
      createdByAccountId: issuer.accountId,
    },
    db
  )

  return { courseId: created.course.id, secret, linkId: link.id }
}

describe('routes/join-links.ts (ENRL-8)', () => {
  it('a signed-out caller is told to sign in', async () => {
    testDb = createTestDatabase()
    const issuer = seedSignedInCaller(testDb.db)
    const { secret } = seedJoinLink(testDb.db, issuer)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .post('/join-links/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ secret })

    expect(response.status).toBe(401)
    expect((response.body as { error: string }).error).toBe('not_signed_in')
  })

  it('redeeming enrols the caller, and the enrolment is one the chat route accepts', async () => {
    testDb = createTestDatabase()
    // A different account, with its own, unrelated organization — a
    // student signing up for the first time has never touched the
    // institution `issuer` teaches through.
    const issuer = seedSignedInCaller(testDb.db)
    const redeemer = seedSignedInCaller(testDb.db)
    const { courseId, secret } = seedJoinLink(testDb.db, issuer)

    const app = await buildTestApp(testDb.db)
    const redeemResponse = await request(app)
      .post('/join-links/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', redeemer.cookieHeader)
      .send({ secret })

    expect(redeemResponse.status).toBe(200)
    expect((redeemResponse.body as { courseId: string }).courseId).toBe(
      courseId
    )

    // The integration this slice's brief calls for: not a second unit test
    // that merely assumes `enrolments.getActiveEnrolment` would find this
    // row, but the actual route `routes/chat.ts` that authorizes on it —
    // in `issuer`'s organization, which `redeemer` had no prior
    // relationship to at all.
    const chatResponse = await request(app)
      .get(`/organizations/${issuer.organizationId}/chat/courses`)
      .set('Cookie', redeemer.cookieHeader)

    expect(chatResponse.status).toBe(200)
    const body = chatResponse.body as { courses: { id: string }[] }
    expect(body.courses.map((course) => course.id)).toEqual([courseId])
  })

  // ENRL-8: a body-supplied `personId` must not redirect the enrolment to
  // anyone else — `z.strictObject` refuses the extra field outright, rather
  // than silently ignoring it, which would leave a reviewer unable to tell
  // "this was ignored" from "this happened to have no effect this time."
  it('refuses a request body carrying a personId, enrolling nobody', async () => {
    testDb = createTestDatabase()
    const issuer = seedSignedInCaller(testDb.db)
    const redeemer = seedSignedInCaller(testDb.db)
    const victim = people.createPerson(issuer.organizationId, {}, testDb.db)
    const { courseId, secret } = seedJoinLink(testDb.db, issuer)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .post('/join-links/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', redeemer.cookieHeader)
      .send({ secret, personId: victim.id })

    expect(response.status).toBe(400)
    expect((response.body as { error: string }).error).toBe(
      'action_input_invalid'
    )
    expect(
      enrolments.listPeopleForCourse(issuer.organizationId, courseId, testDb.db)
    ).toHaveLength(0)
  })

  // ENRL-4/ENRL-8: never-issued, revoked and expired are refused
  // byte-identically — the same status, the same body, across all three.
  it('never-issued, revoked and expired secrets produce byte-identical refusals', async () => {
    testDb = createTestDatabase()
    const issuer = seedSignedInCaller(testDb.db)
    const redeemer = seedSignedInCaller(testDb.db)
    const { secret: revokedSecret, linkId } = seedJoinLink(testDb.db, issuer)
    courseJoinLinks.revokeJoinLink(issuer.organizationId, linkId, testDb.db)
    // Already expired at the moment it is created — the same `now - 1000`
    // device `packages/db/tests/course-join-links.test.ts`'s own "an
    // expired link admits nobody" uses, rather than a real-time wait.
    const { secret: expiredSecret } = seedJoinLink(testDb.db, issuer, {
      expiresAt: Date.now() - 1000,
    })

    const app = await buildTestApp(testDb.db)
    const responses = await Promise.all(
      ['never-issued-secret', revokedSecret, expiredSecret].map((secret) =>
        request(app)
          .post('/join-links/redeem')
          .set('Origin', TEST_PUBLIC_APP_URL)
          .set('Cookie', redeemer.cookieHeader)
          .send({ secret })
      )
    )

    for (const response of responses) {
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: 'join_link_not_found' })
    }
  })
})
