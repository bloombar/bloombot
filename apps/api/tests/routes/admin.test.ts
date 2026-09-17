/**
 * The platform-administrator console, over HTTP (ADMIN-4, ADMIN-5).
 *
 * The test that matters most in this file is not "an admin sees
 * organizations" — it is `ADMIN-4's own boundary`, below: a platform
 * administrator's session, real and valid, attempting the *actual*
 * transcript-read route (`POST .../actions/transcripts.read`) against a
 * tenant they hold no membership in, and getting refused exactly the way
 * anyone else would. Proven by attempting it, not by asserting the
 * absence of a route (a route that does not exist today says nothing
 * about one that might be added tomorrow without anyone noticing it
 * crossed this boundary).
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { createSession } from '@bloombot/auth'
import {
  accounts,
  courseApproval,
  createFilesystemAttachmentStorage,
  memberships,
  organizations,
  people,
  transcriptExports,
  courses as coursesRepo,
  projects as projectsRepo,
} from '@bloombot/db'

import {
  buildTestApp,
  TEST_ATTACHMENT_STORAGE_DIR,
  TEST_PUBLIC_APP_URL,
} from '../helpers/build-test-app.js'
import { SESSION_COOKIE_NAME } from '../../src/middleware/session.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase
const originalAdminEmails = process.env['ADMIN_EMAILS']

afterEach(() => {
  testDb.cleanup()
  if (originalAdminEmails === undefined) delete process.env['ADMIN_EMAILS']
  else process.env['ADMIN_EMAILS'] = originalAdminEmails
})

/** Polls `read()` until it resolves `undefined` (a delayed sweep's own removal, running on its own timer outside this test's control) or a bound is hit. */
async function pollUntilUndefined(
  read: () => Promise<Buffer | undefined>,
  timeoutMs = 2000
): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if ((await read()) === undefined) return
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`pollUntilUndefined: still defined after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A signed-in account whose email is on the `ADMIN_EMAILS` allowlist (AUTH-4) — deliberately holding no membership anywhere, the same way a real platform administrator need not be an instructor on any one tenant. */
function seedPlatformAdministrator(db: import('@bloombot/db').Database) {
  const email = `admin-${randomUUID()}@bloombot.example`
  process.env['ADMIN_EMAILS'] = email
  // An administrator still needs *an* account to sign in with — created
  // with no organization of its own reachable through this helper (TEN-1's
  // "an account gets a personal organization on sign-up" still applies in
  // reality; this test only needs the account id and a session, not a
  // realistic personal org).
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Admin’s Own Org', isPersonal: true },
    db
  )
  const account = accounts.createAccount(
    organizationId,
    { email, displayName: 'Platform Admin', role: 'owner' },
    db
  )
  const session = createSession(account.id, db)
  return {
    accountId: account.id,
    cookieHeader: `${SESSION_COOKIE_NAME}=${session.token}`,
  }
}

/** A tenant with a course, a student and one message — enough for `transcripts.read` to have something to disclose if the boundary this file tests ever broke. */
function seedTenantWithTranscript(db: import('@bloombot/db').Database) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'A Real Tenant', isPersonal: false },
    db
  )
  const project = projectsRepo.createProject(
    organizationId,
    { name: 'Fall 2026' },
    db
  )
  const courseResult = coursesRepo.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Web Design',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  return { organizationId, courseId: courseResult.course.id }
}

describe('ADMIN-4 — a platform administrator sees tenants, not conversations', () => {
  // The test this file exists for: a real platform-administrator session
  // cannot read a tenant's transcript, because AUTH-4's allowlist is not a
  // membership and never becomes one.
  it('a platform administrator’s own session cannot read a tenant’s transcript — refused exactly like anyone else with no membership', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/organizations/${organizationId}/actions/transcripts.read`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ courseId })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'action_refused' })
  })

  // The same proof again, once more concretely — even a platform
  // administrator who legitimately joins a tenant only gains what that
  // membership grants, not anything from `ADMIN_EMAILS`. Left implicit:
  // membership itself already fully authorizes `transcripts.read`
  // (`packages/actions/tests/transcripts.test.ts`), and AUTH-4 adds
  // nothing beyond it or in place of it either way.
  it('GET /admin/organizations exposes usage and health, never a course, a person or a message', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/admin/organizations')
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const body = response.body as {
      organizations: unknown[]
      platformHealth: unknown
    }
    expect(Array.isArray(body.organizations)).toBe(true)
    expect(body.platformHealth).toBeDefined()
    const serialized = JSON.stringify(body)
    // ADMIN-4's own text, checked structurally rather than trusted by
    // convention: nothing in this response ever names a course, a
    // conversation or a message field.
    expect(serialized).not.toMatch(/courseId|conversationId|messageId/i)
  })

  it('refuses a signed-in caller who is not a platform administrator (403)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/admin/organizations')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'not_platform_administrator' })
  })

  it('refuses an anonymous caller (401)', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/admin/organizations')
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(401)
  })
})

describe('ADMIN-5 — deleting a tenant’s data is explicit, confirmed and audited', () => {
  it('previews exactly what will be deleted before anything happens', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    people.createPerson(organizationId, { displayName: 'A Student' }, testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/organizations/${organizationId}/deletion-preview`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      organizationId,
      organizationName: 'A Real Tenant',
      courses: 1,
      people: 1,
    })
    // Nothing touched — still there.
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
    expect(courseId).toBeTruthy()
  })

  // The finding this project's own history warns future slices about: a
  // destructive confirmation that only *looks* enforced. Sending the wrong
  // name must refuse — server-side, not merely disable a button in the
  // panel — and delete nothing.
  it('refuses to delete when the confirmation name does not match, and deletes nothing (409)', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/admin/organizations/${organizationId}/delete`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ confirmName: 'the wrong name entirely' })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'confirmation_name_mismatch' })
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
  })

  it('deletes the tenant once the confirmation name matches exactly, and records who did it', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/admin/organizations/${organizationId}/delete`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ confirmName: 'A Real Tenant' })

    expect(response.status).toBe(200)
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeUndefined()

    const deletions = organizations.listTenantDeletions(testDb.db)
    expect(deletions).toHaveLength(1)
    expect(deletions[0]).toMatchObject({
      organizationId,
      organizationName: 'A Real Tenant',
      deletedByAccountId: admin.accountId,
    })

    const auditResponse = await request(app)
      .get('/admin/tenant-deletions')
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(auditResponse.status).toBe(200)
    const auditBody = auditResponse.body as {
      deletions: { organizationId: string }[]
    }
    expect(auditBody.deletions[0]?.organizationId).toBe(organizationId)
  })

  it('refuses a non-administrator (403), and deletes nothing', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { organizationId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/admin/organizations/${organizationId}/delete`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ confirmName: 'A Real Tenant' })

    expect(response.status).toBe(403)
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
  })

  it('cleans up a stored transcript export’s bytes when its tenant is deleted', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: `${randomUUID()}@example.edu`,
        displayName: 'Instructor',
        role: 'owner',
      },
      testDb.db
    )
    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      { courseId, requestedByAccountId: instructor.id },
      testDb.db
    )
    // The part this test's own name claims to prove: real bytes, actually
    // on disk, under the same `AttachmentStorage` root the route itself
    // builds (`TEST_ATTACHMENT_STORAGE_DIR`) — a second instance over the
    // same directory, the same "stateless port" reasoning `server.ts`'s own
    // module comment gives for building its own second instance too.
    const attachmentStorage = createFilesystemAttachmentStorage(
      TEST_ATTACHMENT_STORAGE_DIR
    )
    await attachmentStorage.write(
      organizationId,
      exportRow.id,
      Buffer.from('{"transcript":[]}')
    )
    expect(
      await attachmentStorage.read(organizationId, exportRow.id)
    ).toBeDefined()

    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/admin/organizations/${organizationId}/delete`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ confirmName: 'A Real Tenant' })

    expect(response.status).toBe(200)
    expect(
      memberships.getMembership(organizationId, instructor.id, testDb.db)
    ).toBeUndefined()
    // The bytes seeded above are actually gone — not merely the database
    // row that named them.
    expect(
      await attachmentStorage.read(organizationId, exportRow.id)
    ).toBeUndefined()
  })

  // Must-fix 1, this rework's own fourth round — ADMIN-5's own race with
  // `apps/worker`'s export handler: an in-flight job can land bytes on
  // disk *after* the tenant's own rows (and this route's own immediate
  // best-effort sweep) are already gone. The delayed second sweep
  // (`deletedTenantSweepDelayMs`) is what still catches it.
  //
  // A prior version of this test wrote the simulated bytes itself, after
  // `await request(app)...` resolved, and polled for their removal —
  // which reads as "the write happens after the response, and the delayed
  // sweep catches it later", but is not what actually races: `routes/
  // admin.ts`'s own delayed `setTimeout` is scheduled *inside*
  // `sweepStorage(...).then(...)`, before the response is ever sent, so
  // the timer was already running, on its own real clock, throughout the
  // time this test spent on its own assertions and a `Buffer.from` call
  // before writing — a genuine race between wall-clock time this test
  // does not control and the fixed `deletedTenantSweepDelayMs` below.
  // Widening the poll or the delay only widens that race; it does not
  // close it, which is exactly why this failed at roughly one run in five
  // even against a generous two-second poll (verified by hand, patching
  // the fix out below).
  //
  // Fixed to make the *ordering* the test relies on true by construction
  // rather than by timing: `attachmentStorage`'s own `remove` is wrapped
  // so that its first call for this export's own id performs the
  // simulated worker write as a side effect *after* removing (a no-op —
  // nothing is there yet) — landing the bytes on disk during the
  // *immediate* sweep's own `Promise.all`, before that promise settles,
  // before `.then()` ever schedules the delayed sweep's own timer. No
  // wall-clock assumption is left for this test to lose.
  it('a byte the immediate sweep passes over, written the moment it does, is still removed by the delayed sweep', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: `${randomUUID()}@example.edu`,
        displayName: 'Instructor',
        role: 'owner',
      },
      testDb.db
    )
    // Still `pending` — no bytes on disk yet, the same state a real export
    // job that has not finished writing leaves it in.
    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      { courseId, requestedByAccountId: instructor.id },
      testDb.db
    )
    const realAttachmentStorage = createFilesystemAttachmentStorage(
      TEST_ATTACHMENT_STORAGE_DIR
    )
    // Simulates `apps/worker`'s own export handler landing its write in
    // the narrow window the immediate sweep's own pass over this exact id
    // leaves open — exactly the race `apps/worker/src/handlers/
    // transcripts.ts`'s own module comment describes, and the reason a
    // re-check alone (that file's own fix) is not sufficient on its own
    // without this route's own second pass. Guarded to fire once: the
    // *delayed* sweep also calls `remove` for this same id, and must not
    // find the bytes rewritten out from under its own real removal.
    let simulatedWorkerWriteDone = false
    const attachmentStorage = {
      ...realAttachmentStorage,
      remove: async (org: string, id: string) => {
        await realAttachmentStorage.remove(org, id)
        if (id === exportRow.id && !simulatedWorkerWriteDone) {
          simulatedWorkerWriteDone = true
          await realAttachmentStorage.write(
            org,
            id,
            Buffer.from(
              '{"transcript":["a departed tenant\u2019s own student speech"]}'
            )
          )
        }
      },
    }
    const app = await buildTestApp(testDb.db, {
      attachmentStorage,
      // A test overrides the five-second production default to a few
      // milliseconds — this test is not waiting five real seconds to prove
      // the sweep runs.
      deletedTenantSweepDelayMs: 20,
    })

    const response = await request(app)
      .post(`/admin/organizations/${organizationId}/delete`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ confirmName: 'A Real Tenant' })
    expect(response.status).toBe(200)

    // The organization's own rows are gone; the immediate sweep already
    // ran (its own `remove` call landed the simulated write above, as a
    // side effect, before this response was ever sent).
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeUndefined()

    // The delayed sweep, configured above to run almost immediately,
    // catches what the immediate one could not have — polled rather than
    // asserted once, since it still runs on its own `setTimeout`, outside
    // this test's own control (only *when the bytes were written*, not
    // *when they are removed*, is deterministic here).
    await pollUntilUndefined(() =>
      realAttachmentStorage.read(organizationId, exportRow.id)
    )
  })
})

describe('WEB-53 — a platform administrator approves and unapproves courses', () => {
  it('refuses a non-administrator and a signed-out caller on GET /courses, approve and unapprove', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const attempts: (() => request.Test)[] = [
      () => request(app).get('/admin/courses'),
      () => request(app).post(`/admin/courses/${courseId}/approve`),
      () => request(app).post(`/admin/courses/${courseId}/unapprove`),
    ]

    for (const attempt of attempts) {
      const signedOut = await attempt().set('Origin', TEST_PUBLIC_APP_URL)
      expect(signedOut.status).toBe(401)

      const notAdmin = await attempt()
        .set('Cookie', caller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
      expect(notAdmin.status).toBe(403)
      expect(notAdmin.body).toEqual({ error: 'not_platform_administrator' })
    }

    // Refused, not merely unauthorized — the approve/unapprove attempts
    // above never touched the course.
    expect(
      coursesRepo.getCourse(organizationId, courseId, testDb.db)?.aiApprovedAt
    ).toBeNull()
  })

  it('lists pending and approved courses, never a person, a conversation or a message', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/admin/courses')
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const body = response.body as { courses: { courseId: string }[] }
    const row = body.courses.find((course) => course.courseId === courseId)
    expect(row).toMatchObject({
      courseId,
      courseTitle: 'Web Design',
      organizationId,
      organizationName: 'A Real Tenant',
      aiApprovedAt: null,
      aiApprovedByAccountId: null,
      aiApprovedByEmail: null,
    })
    // ADMIN-4's own boundary, checked structurally here too (this file's
    // own module comment on why the existing boundary test is extended
    // rather than a new pattern added) — a course's identifying detail is
    // in bounds, a conversation or a message is not.
    expect(JSON.stringify(body)).not.toMatch(/conversationId|messageId/i)
  })

  it('approve makes a course answerable and writes an audit event, naming who and when', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/admin/courses/${courseId}/approve`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ approved: true })

    const course = coursesRepo.getCourse(organizationId, courseId, testDb.db)
    expect(course?.aiApprovedAt).not.toBeNull()
    expect(course?.aiApprovedByAccountId).toBe(admin.accountId)

    const events = courseApproval.listApprovalEventsForCourse(
      organizationId,
      courseId,
      testDb.db
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: 'approve',
      accountId: admin.accountId,
    })
  })

  it('approving an already-approved course is a no-op success, not an error, and writes no second event', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const first = await request(app)
      .post(`/admin/courses/${courseId}/approve`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(first.status).toBe(200)

    const second = await request(app)
      .post(`/admin/courses/${courseId}/approve`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ approved: true })

    expect(
      courseApproval.listApprovalEventsForCourse(
        organizationId,
        courseId,
        testDb.db
      )
    ).toHaveLength(1)
  })

  it('unapprove makes a course unanswerable again, and it is never auto-re-approved afterwards', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    await request(app)
      .post(`/admin/courses/${courseId}/approve`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    const response = await request(app)
      .post(`/admin/courses/${courseId}/unapprove`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ approved: false })

    const course = coursesRepo.getCourse(organizationId, courseId, testDb.db)
    expect(course?.aiApprovedAt).toBeNull()
    expect(course?.aiApprovedByAccountId).toBeNull()
    // COST-8's `ai_approval_decided_at` — set by the revoke, and the reason
    // `answerQuestion`'s own lazy auto-approval never re-approves this
    // course silently after a platform administrator's deliberate revoke.
    expect(course?.aiApprovalDecidedAt).not.toBeNull()

    const events = courseApproval.listApprovalEventsForCourse(
      organizationId,
      courseId,
      testDb.db
    )
    expect(events[0]).toMatchObject({
      action: 'revoke',
      accountId: admin.accountId,
    })
  })

  it('unapproving an already-pending course is a no-op success, not an error', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/admin/courses/${courseId}/unapprove`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ approved: false })
    expect(
      courseApproval.listApprovalEventsForCourse(
        organizationId,
        courseId,
        testDb.db
      )
    ).toHaveLength(0)
  })

  it('404s on approve and unapprove for a course id that does not exist', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const app = await buildTestApp(testDb.db)
    const missingCourseId = randomUUID()

    const approveResponse = await request(app)
      .post(`/admin/courses/${missingCourseId}/approve`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(approveResponse.status).toBe(404)
    expect(approveResponse.body).toEqual({ error: 'course_not_found' })

    const unapproveResponse = await request(app)
      .post(`/admin/courses/${missingCourseId}/unapprove`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(unapproveResponse.status).toBe(404)
    expect(unapproveResponse.body).toEqual({ error: 'course_not_found' })
  })
})
