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

import { COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND } from '@bloombot/actions'
import { createSession } from '@bloombot/auth'
import {
  accounts,
  conversations,
  costLedger,
  courseApproval,
  courseAttachments,
  courseJoinLinks,
  courseWebSources,
  createFilesystemAttachmentStorage,
  enrolments,
  jobs,
  memberships,
  organizations,
  people,
  rosterImportAcknowledgements,
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
  return {
    organizationId,
    courseId: courseResult.course.id,
    projectId: project.id,
  }
}

/**
 * ADMIN-6's own tenant: a course carrying every settings group the route
 * reads back — a category with a channel (Discord category/role names), a
 * model, instructions and a max-requests-per-day (AI), one ready knowledge
 * file and one website (Knowledge) — plus a person and a join link
 * (`joinLinkSecretHash`) the boundary test below proves stay unreachable
 * through this route regardless.
 */
function seedCourseWithSettings(db: import('@bloombot/db').Database) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Settings Tenant', isPersonal: false },
    db
  )
  const project = projectsRepo.createProject(
    organizationId,
    { name: 'Spring 2027' },
    db
  )
  const courseResult = coursesRepo.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Intro to Botany',
      enabled: true,
      adminsRole: 'admins-botany',
      studentsRole: 'students-botany',
      model: 'gpt-5',
      instructions: 'Answer only from the syllabus.',
      maxRequestsPerDay: 20,
      conversationScope: 'course',
      selfEnrolFromDiscord: true,
      answerUnenrolled: false,
      categories: [
        {
          name: 'Botany 101',
          channels: [{ name: 'general', adminsOnly: false }],
        },
      ],
    },
    db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  const courseId = courseResult.course.id

  const attachment = courseAttachments.createPendingAttachment(
    organizationId,
    {
      courseId,
      filename: 'syllabus.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
    },
    db
  )
  courseAttachments.markAttachmentReady(
    organizationId,
    attachment.id,
    'provider-file-1',
    db
  )
  courseWebSources.addWebSource(
    organizationId,
    { courseId, domain: 'botany.example.edu' },
    db
  )

  const person = people.createPerson(
    organizationId,
    { displayName: 'A Secret Student' },
    db
  )
  // A real account, not a bare `randomUUID()` — `course_join_links.created_by_account_id`
  // references `accounts.id` (`schema.ts`), the same "an owning account" this
  // course's own organization needs anyway for the join link to be valid.
  const owner = accounts.createAccount(
    organizationId,
    {
      email: `owner-${randomUUID()}@example.edu`,
      displayName: 'Owner',
      role: 'owner',
    },
    db
  )
  const joinLinkSecretHash = 'a'.repeat(64)
  courseJoinLinks.createJoinLink(
    organizationId,
    {
      courseId,
      secretHash: joinLinkSecretHash,
      createdByAccountId: owner.id,
    },
    db
  )

  return { organizationId, courseId, personId: person.id, joinLinkSecretHash }
}

/**
 * ADMIN-7..11's own tenant: an organization owned by one account, with an
 * active project holding one enabled course and an archived project holding
 * a second (disabled) course — so the organization/project reads below have
 * something to prove they nest courses correctly under the right project,
 * archived or not. One person is enrolled in the active course, connected to
 * a real account (so ADMIN-9's own `accountId` link, and ADMIN-11's own
 * enrolments list, both have something to find), with one cost-ledger entry
 * recorded against them.
 */
function seedConsoleTenant(db: import('@bloombot/db').Database) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Console Org', isPersonal: false },
    db
  )
  const owner = accounts.createAccount(
    organizationId,
    {
      email: `owner-${randomUUID()}@example.edu`,
      displayName: 'Owner',
      role: 'owner',
    },
    db
  )

  const activeProject = projectsRepo.createProject(
    organizationId,
    { name: 'Fall 2026' },
    db
  )
  const activeCourseResult = coursesRepo.createCourse(
    organizationId,
    {
      projectId: activeProject.id,
      title: 'Course A',
      enabled: true,
      adminsRole: 'admins-a',
      studentsRole: 'students-a',
      categories: [],
    },
    db
  )
  if (!activeCourseResult.ok) throw new Error('seed course creation failed')
  const courseId = activeCourseResult.course.id

  const archivedProject = projectsRepo.createProject(
    organizationId,
    { name: 'Spring 2020' },
    db
  )
  projectsRepo.archiveProject(organizationId, archivedProject.id, db)
  const archivedCourseResult = coursesRepo.createCourse(
    organizationId,
    {
      projectId: archivedProject.id,
      title: 'Course B',
      enabled: false,
      adminsRole: 'admins-b',
      studentsRole: 'students-b',
      categories: [],
    },
    db
  )
  if (!archivedCourseResult.ok) throw new Error('seed course creation failed')

  const studentAccount = accounts.createAccount(
    organizationId,
    {
      email: `student-${randomUUID()}@example.edu`,
      displayName: 'Student One',
      role: 'assistant',
    },
    db
  )
  const person = people.createPerson(
    organizationId,
    { displayName: 'Student One', email: 'student1@example.edu' },
    db
  )
  people.connectIdentity(
    organizationId,
    person.id,
    { surface: 'web', externalId: studentAccount.id },
    db
  )
  enrolments.enrolViaJoinLink(
    organizationId,
    { courseId, personId: person.id },
    db
  )
  costLedger.recordCostLedgerEntry(
    organizationId,
    {
      courseId,
      personId: person.id,
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 20,
      costMicros: 1000,
      measurement: 'measured',
      surface: 'web',
    },
    db
  )

  return {
    organizationId,
    ownerId: owner.id,
    activeProjectId: activeProject.id,
    archivedProjectId: archivedProject.id,
    courseId,
    archivedCourseId: archivedCourseResult.course.id,
    personId: person.id,
    studentAccountId: studentAccount.id,
  }
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

  // ROST-20 rework finding: `roster_import_acknowledgements` is a real
  // foreign key to `courses.id`, `jobs.id` and `organizations.id` alike
  // (`schema.ts`'s own comment) — a tenant that ever had a roster imported
  // used to throw `FOREIGN KEY constraint failed` on this very delete,
  // aborting it entirely, before `organizations.ts#deleteOrganizationData`
  // emptied this table first.
  it('deletes a tenant that has an acknowledged roster import', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: `instructor-${randomUUID()}@example.edu`,
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const job = jobs.enqueueJob(
      organizationId,
      { kind: 'roster.import', payload: {}, maxAttempts: 5 },
      testDb.db
    )
    rosterImportAcknowledgements.recordAcknowledgement(
      organizationId,
      {
        courseId,
        accountId: instructor.id,
        filename: 'roster.csv',
        jobId: job.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: Date.now(),
      },
      testDb.db
    )
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
  it('refuses a non-administrator, a signed-out caller and a disabled administrator on GET /courses, approve and unapprove', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    // `isRequestFromPlatformAdministrator`'s own `account.disabledAt !== null`
    // check (`routes/admin.ts`) — a disabled account whose session token
    // still validated would fail that check, but in practice
    // `@bloombot/db`'s `sessions.validateSession` already excludes a
    // disabled account's own sessions (its own doc comment: "one whose
    // account is disabled"), and `accounts.disableAccount` revokes every
    // session the account held on top of that — so this admin's own cookie
    // is refused at the session layer, the identical 401
    // `auth-flow.spec.ts`'s own "its session cookie no longer
    // authenticates" test already proves for an ordinary account. Still
    // worth asserting here, on this router specifically: a disabled
    // platform administrator gets no special path back in.
    const disabledAdmin = seedPlatformAdministrator(testDb.db)
    accounts.disableAccount(disabledAdmin.accountId, testDb.db)
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

      const disabled = await attempt()
        .set('Cookie', disabledAdmin.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
      expect(disabled.status).toBe(401)
    }

    // Refused, not merely unauthorized — the approve/unapprove attempts
    // above never touched the course.
    expect(
      coursesRepo.getCourse(organizationId, courseId, testDb.db)?.aiApprovedAt
    ).toBeNull()
  })

  it('lists pending and approved courses, with a project id and owner ids for the console to link to, never a person, a conversation or a message', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId, projectId } = seedTenantWithTranscript(
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/admin/courses')
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const body = response.body as {
      courses: {
        courseId: string
        projectId: string
        owners: { accountId: string; email: string }[]
      }[]
    }
    const row = body.courses.find((course) => course.courseId === courseId)
    expect(row).toMatchObject({
      courseId,
      courseTitle: 'Web Design',
      // ADMIN-12/ADMIN-7 — a project id, not only its name, so the
      // console's Courses row can link to it (`CoursesView.tsx`).
      projectId,
      organizationId,
      organizationName: 'A Real Tenant',
      // No owner account seeded here — a course whose organization has no
      // owners yet.
      owners: [],
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

    // ADMIN-14 — this unapprove was a genuine revoke (an approved course
    // going pending), so it must enqueue one `courseApproval.notifyPending`
    // job naming the course.
    const queued = jobs.listJobsForOrganization(organizationId, 10, testDb.db)
    const notifyJob = queued.find(
      (job) => job.kind === COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND
    )
    expect(notifyJob).toBeDefined()
    expect(JSON.parse(notifyJob?.payload ?? '{}')).toMatchObject({ courseId })
  })

  // Must-fix, first review round: a course that has *never been decided*
  // (every course seeded here predates any approval action, the same state
  // every course that predates COST-8 is actually in) still looks
  // "unapproved" by `aiApprovedAt` alone — the same shape as a course a
  // previous revoke already decided pending. The old version of this test
  // asserted zero audit events on the *first* unapprove of a never-decided
  // course, which is exactly the missing-decision bug: skipping the write
  // there left `aiApprovalDecidedAt` unset, so an administrator-owned
  // organization's next question silently re-approved the course through
  // `answerQuestion`'s own lazy path, reverting the "off" this route just
  // claimed to record. The fix records the decision on the first call
  // (this route's own doc comment) — proven here — and only the *second*
  // call, once the course is genuinely already decided pending, is the
  // true no-op.
  it('unapproving a never-decided pending course records the decision; a second unapprove is the true no-op', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedTenantWithTranscript(testDb.db)
    const app = await buildTestApp(testDb.db)

    // Never decided at all — the state this test's own name describes.
    const before = coursesRepo.getCourse(organizationId, courseId, testDb.db)
    expect(before?.aiApprovedAt).toBeNull()
    expect(before?.aiApprovalDecidedAt).toBeNull()

    const first = await request(app)
      .post(`/admin/courses/${courseId}/unapprove`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ approved: false })

    // The decision is now recorded — `aiApprovalDecidedAt` is set, and a
    // `revoke` event named the administrator, so a future lazy
    // auto-approval (COST-8) will not silently undo this.
    const afterFirst = coursesRepo.getCourse(
      organizationId,
      courseId,
      testDb.db
    )
    expect(afterFirst?.aiApprovedAt).toBeNull()
    expect(afterFirst?.aiApprovalDecidedAt).not.toBeNull()
    const eventsAfterFirst = courseApproval.listApprovalEventsForCourse(
      organizationId,
      courseId,
      testDb.db
    )
    expect(eventsAfterFirst).toHaveLength(1)
    expect(eventsAfterFirst[0]).toMatchObject({
      action: 'revoke',
      accountId: admin.accountId,
    })

    // ADMIN-14 — the first call actually called `revokeCourseApproval`
    // (this test's own name), so it must enqueue one
    // `courseApproval.notifyPending` job.
    const queuedAfterFirst = jobs.listJobsForOrganization(
      organizationId,
      10,
      testDb.db
    )
    expect(
      queuedAfterFirst.filter(
        (job) => job.kind === COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND
      )
    ).toHaveLength(1)

    // Now the course is already decided pending — a second unapprove is a
    // genuine no-op: 200, no further event.
    const second = await request(app)
      .post(`/admin/courses/${courseId}/unapprove`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ approved: false })
    expect(
      courseApproval.listApprovalEventsForCourse(
        organizationId,
        courseId,
        testDb.db
      )
    ).toHaveLength(1)

    // ADMIN-14 — the second call is the idempotent skip: still no second
    // notification job.
    const queuedAfterSecond = jobs.listJobsForOrganization(
      organizationId,
      10,
      testDb.db
    )
    expect(
      queuedAfterSecond.filter(
        (job) => job.kind === COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND
      )
    ).toHaveLength(1)
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

describe('ADMIN-6 — a platform administrator reads a course’s settings, read-only', () => {
  it('returns the course’s general, AI and knowledge settings, plus its approval state', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedCourseWithSettings(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      courseId,
      courseTitle: 'Intro to Botany',
      enabled: true,
      organizationId,
      organizationName: 'Settings Tenant',
      projectName: 'Spring 2027',
      adminsRole: 'admins-botany',
      studentsRole: 'students-botany',
      categories: [
        {
          name: 'Botany 101',
          channels: [{ name: 'general', adminsOnly: false }],
        },
      ],
      conversationScope: 'course',
      model: 'gpt-5',
      promptId: null,
      instructions: 'Answer only from the syllabus.',
      maxRequestsPerDay: 20,
      selfEnrolFromDiscord: true,
      answerUnenrolled: false,
      attachments: [
        { filename: 'syllabus.pdf', sizeBytes: 4096, status: 'ready' },
      ],
      webSources: [{ domain: 'botany.example.edu' }],
      aiApprovedAt: null,
      aiApprovedByAccountId: null,
      aiApprovedByEmail: null,
    })
  })

  // The boundary this whole console exists to hold (this file's own module
  // comment, and `routes/admin.ts`'s own): a course's settings are in
  // bounds, ADMIN-6's own exception, but the *person* and the *join link*
  // `seedCourseWithSettings` deliberately seeds alongside them are not.
  // Checked structurally, the same pattern the existing ADMIN-4 boundary
  // tests above already use (`JSON.stringify` plus a field-name/value
  // check), rather than a new one — proven by the actual seeded values
  // being genuinely absent, not merely by the response having no field
  // that could carry them.
  it('never names the course’s person or its join link’s secret', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { courseId, personId, joinLinkSecretHash } = seedCourseWithSettings(
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const serialized = JSON.stringify(response.body)
    expect(serialized).not.toMatch(/personId|conversationId|messageId/i)
    expect(serialized).not.toContain(personId)
    expect(serialized).not.toContain('A Secret Student')
    expect(serialized).not.toContain(joinLinkSecretHash)
  })

  it('refuses a signed-out caller (401), a non-administrator (403) and a disabled administrator (401)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { courseId } = seedCourseWithSettings(testDb.db)
    const disabledAdmin = seedPlatformAdministrator(testDb.db)
    accounts.disableAccount(disabledAdmin.accountId, testDb.db)
    const app = await buildTestApp(testDb.db)

    const signedOut = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(signedOut.status).toBe(401)

    const notAdmin = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(notAdmin.status).toBe(403)
    expect(notAdmin.body).toEqual({ error: 'not_platform_administrator' })

    const disabled = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Cookie', disabledAdmin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(disabled.status).toBe(401)
  })

  it('404s on a course id that does not exist', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const app = await buildTestApp(testDb.db)
    const missingCourseId = randomUUID()

    const response = await request(app)
      .get(`/admin/courses/${missingCourseId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'course_not_found' })
  })
})

describe('ADMIN-7 — an organization has its own console screen', () => {
  it('lists its projects, each project’s courses, per-course enrolment counts and cost', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const seed = seedConsoleTenant(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/organizations/${seed.organizationId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const body = response.body as {
      organizationId: string
      name: string
      isPersonal: boolean
      usage: { totalCostMicros: number; callCount: number }
      owners: { accountId: string }[]
      projects: {
        projectId: string
        archivedAt: number | null
        courses: {
          courseId: string
          title: string
          enabled: boolean
          enrolmentCount: number
          totalCostMicros: number
        }[]
      }[]
    }

    expect(body.organizationId).toBe(seed.organizationId)
    expect(body.name).toBe('Console Org')
    expect(body.isPersonal).toBe(false)
    expect(body.usage.totalCostMicros).toBe(1000)
    expect(body.usage.callCount).toBe(1)
    expect(body.owners).toEqual([
      expect.objectContaining({ accountId: seed.ownerId }),
    ])

    const activeProject = body.projects.find(
      (project) => project.projectId === seed.activeProjectId
    )
    expect(activeProject?.archivedAt).toBeNull()
    expect(activeProject?.courses).toEqual([
      expect.objectContaining({
        courseId: seed.courseId,
        title: 'Course A',
        enabled: true,
        enrolmentCount: 1,
        totalCostMicros: 1000,
      }),
    ])

    const archivedProject = body.projects.find(
      (project) => project.projectId === seed.archivedProjectId
    )
    expect(archivedProject?.archivedAt).not.toBeNull()
    expect(archivedProject?.courses).toEqual([
      expect.objectContaining({
        courseId: seed.archivedCourseId,
        title: 'Course B',
        enabled: false,
        enrolmentCount: 0,
        totalCostMicros: 0,
      }),
    ])
  })

  it('404s on an organization id that does not exist', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/organizations/${randomUUID()}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'organization_not_found' })
  })

  it('refuses a signed-out caller (401) and a non-administrator (403)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { organizationId } = seedConsoleTenant(testDb.db)
    const app = await buildTestApp(testDb.db)

    const signedOut = await request(app)
      .get(`/admin/organizations/${organizationId}`)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(signedOut.status).toBe(401)

    const notAdmin = await request(app)
      .get(`/admin/organizations/${organizationId}`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(notAdmin.status).toBe(403)
  })
})

describe('ADMIN-8 — a project has its own console screen', () => {
  it('lists its courses, each with approval state, enrolment count and usage, and its organization', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const seed = seedConsoleTenant(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/projects/${seed.activeProjectId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      projectId: seed.activeProjectId,
      name: 'Fall 2026',
      organizationId: seed.organizationId,
      organizationName: 'Console Org',
      archivedAt: null,
      courses: [
        {
          courseId: seed.courseId,
          title: 'Course A',
          enabled: true,
          enrolmentCount: 1,
          totalCostMicros: 1000,
        },
      ],
    })
  })

  it('404s on a project id that does not exist', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/projects/${randomUUID()}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'project_not_found' })
  })

  it('refuses a signed-out caller (401) and a non-administrator (403)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const seed = seedConsoleTenant(testDb.db)
    const app = await buildTestApp(testDb.db)

    const signedOut = await request(app)
      .get(`/admin/projects/${seed.activeProjectId}`)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(signedOut.status).toBe(401)

    const notAdmin = await request(app)
      .get(`/admin/projects/${seed.activeProjectId}`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(notAdmin.status).toBe(403)
  })
})

describe('ADMIN-9 — a course’s console screen shows the course and the people in it', () => {
  it('lists enrolled people with their own usage, and still returns every field the response carried before', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedCourseWithSettings(testDb.db)
    const person = people.createPerson(
      organizationId,
      { displayName: 'Enrolled Student', email: 'enrolled@example.edu' },
      testDb.db
    )
    const account = accounts.createAccount(
      organizationId,
      {
        email: `linked-${randomUUID()}@example.edu`,
        displayName: 'Enrolled Student',
        role: 'assistant',
      },
      testDb.db
    )
    people.connectIdentity(
      organizationId,
      person.id,
      { surface: 'web', externalId: account.id },
      testDb.db
    )
    enrolments.enrolViaJoinLink(
      organizationId,
      { courseId, personId: person.id },
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      organizationId,
      {
        courseId,
        personId: person.id,
        model: 'gpt-5',
        inputTokens: 5,
        outputTokens: 5,
        costMicros: 750,
        measurement: 'measured',
        surface: 'discord',
      },
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    // Every field the ADMIN-6 test above already asserts is still here —
    // widening this response must not drop or rename anything the panel
    // already reads.
    expect(response.body).toMatchObject({
      courseId,
      courseTitle: 'Intro to Botany',
      enabled: true,
      organizationId,
      organizationName: 'Settings Tenant',
      projectName: 'Spring 2027',
      adminsRole: 'admins-botany',
      studentsRole: 'students-botany',
      model: 'gpt-5',
      instructions: 'Answer only from the syllabus.',
      attachments: [
        { filename: 'syllabus.pdf', sizeBytes: 4096, status: 'ready' },
      ],
      webSources: [{ domain: 'botany.example.edu' }],
      usage: { totalCostMicros: 750, callCount: 1 },
      people: [
        {
          personId: person.id,
          displayName: 'Enrolled Student',
          email: 'enrolled@example.edu',
          accountId: account.id,
          totalCostMicros: 750,
          callCount: 1,
        },
      ],
    })
    const body = response.body as { approvalEvents: unknown[] }
    expect(Array.isArray(body.approvalEvents)).toBe(true)
  })

  // ROST-20: the course's own roster-import acknowledgements, alongside
  // the approval history — the acknowledging account's email resolved.
  it("carries the course's own roster-import acknowledgements", async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedCourseWithSettings(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: `instructor-${randomUUID()}@example.edu`,
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )
    const job = jobs.enqueueJob(
      organizationId,
      { kind: 'roster.import', payload: {}, maxAttempts: 5 },
      testDb.db
    )
    rosterImportAcknowledgements.recordAcknowledgement(
      organizationId,
      {
        courseId,
        accountId: instructor.id,
        filename: 'roster.csv',
        jobId: job.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: Date.now(),
      },
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      rosterAcknowledgements: [
        {
          accountId: instructor.id,
          accountEmail: instructor.email,
          filename: 'roster.csv',
          acknowledgementVersion: '2026-09-18',
        },
      ],
    })
  })

  // ADMIN-4's line, as amended in phase 40: this screen may name who is in a
  // course; it may never reach what they said. The course seeded here holds a
  // real conversation with a real message in each direction, so the assertion
  // has content that *could* leak — a response that grew a `messages` field
  // would fail here rather than passing on an empty database.
  it('never carries a message’s content, even once people are listed', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const { organizationId, courseId } = seedCourseWithSettings(testDb.db)
    const person = people.createPerson(
      organizationId,
      { displayName: 'Enrolled Student' },
      testDb.db
    )
    enrolments.enrolViaJoinLink(
      organizationId,
      { courseId, personId: person.id },
      testDb.db
    )
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId, personId: person.id, surface: 'web' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')
    const studentQuestion = 'SECRET-QUESTION-how-do-stomata-work'
    const botAnswer = 'SECRET-ANSWER-they-open-and-close'
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'from_person', content: studentQuestion, surface: 'web' },
      testDb.db
    )
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'to_person', content: botAnswer, surface: 'web' },
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/courses/${courseId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const serialized = JSON.stringify(response.body)
    expect(serialized).not.toContain(studentQuestion)
    expect(serialized).not.toContain(botAnswer)
    expect(serialized).not.toContain(conversation.id)
    expect(serialized).not.toMatch(/conversationId|messageId/i)
  })
})

describe('ADMIN-10 — the console lists the platform’s accounts', () => {
  it('lists every account, newest first, with organization counts and totals', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const seed = seedConsoleTenant(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/admin/accounts')
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const body = response.body as {
      accounts: {
        accountId: string
        createdAt: number
        organizationCount: number
        totalCostMicros: number
      }[]
    }
    expect(Array.isArray(body.accounts)).toBe(true)
    // Newest-first.
    for (let i = 1; i < body.accounts.length; i += 1) {
      expect(body.accounts[i - 1]?.createdAt).toBeGreaterThanOrEqual(
        body.accounts[i]?.createdAt ?? 0
      )
    }
    const owner = body.accounts.find((row) => row.accountId === seed.ownerId)
    expect(owner?.organizationCount).toBe(1)
    const student = body.accounts.find(
      (row) => row.accountId === seed.studentAccountId
    )
    expect(student?.totalCostMicros).toBe(1000)
  })

  it('refuses a signed-out caller (401) and a non-administrator (403)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    const signedOut = await request(app)
      .get('/admin/accounts')
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(signedOut.status).toBe(401)

    const notAdmin = await request(app)
      .get('/admin/accounts')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(notAdmin.status).toBe(403)
  })
})

describe('ADMIN-11 — an account has its own console screen', () => {
  it('carries memberships, connected organizations, people with identities, enrolments and per-course usage', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const seed = seedConsoleTenant(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/accounts/${seed.studentAccountId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    const body = response.body as {
      accountId: string
      memberships: { organizationId: string; role: string }[]
      connectedOrganizations: { organizationId: string; personId: string }[]
      people: {
        personId: string
        organizationId: string
        identities: { surface: string; externalId: string }[]
      }[]
      enrolments: { courseId: string; courseTitle: string }[]
      usage: {
        totalCostMicros: number
        callCount: number
        byCourse: { courseId: string; totalCostMicros: number }[]
      }
    }

    expect(body.accountId).toBe(seed.studentAccountId)
    expect(body.memberships).toEqual([
      expect.objectContaining({
        organizationId: seed.organizationId,
        role: 'assistant',
      }),
    ])
    expect(body.connectedOrganizations).toEqual([
      expect.objectContaining({
        organizationId: seed.organizationId,
        personId: seed.personId,
      }),
    ])
    expect(body.people).toEqual([
      expect.objectContaining({
        personId: seed.personId,
        organizationId: seed.organizationId,
        identities: [
          expect.objectContaining({
            surface: 'web',
            externalId: seed.studentAccountId,
          }),
        ],
      }),
    ])
    expect(body.enrolments).toEqual([
      expect.objectContaining({
        courseId: seed.courseId,
        courseTitle: 'Course A',
      }),
    ])
    expect(body.usage.totalCostMicros).toBe(1000)
    expect(body.usage.callCount).toBe(1)
    expect(body.usage.byCourse).toEqual([
      expect.objectContaining({
        courseId: seed.courseId,
        totalCostMicros: 1000,
      }),
    ])
  })

  it('404s on an account id that does not exist', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/accounts/${randomUUID()}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'account_not_found' })
  })

  it('refuses a signed-out caller (401) and a non-administrator (403)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const seed = seedConsoleTenant(testDb.db)
    const app = await buildTestApp(testDb.db)

    const signedOut = await request(app)
      .get(`/admin/accounts/${seed.studentAccountId}`)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(signedOut.status).toBe(401)

    const notAdmin = await request(app)
      .get(`/admin/accounts/${seed.studentAccountId}`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(notAdmin.status).toBe(403)
  })

  // ROST-20: every roster-import acknowledgement this account has ever
  // made, across every course and organization it has imported into.
  it('carries the account’s own roster-import acknowledgements, across organizations', async () => {
    testDb = createTestDatabase()
    const admin = seedPlatformAdministrator(testDb.db)
    const seed = seedConsoleTenant(testDb.db)
    const job = jobs.enqueueJob(
      seed.organizationId,
      { kind: 'roster.import', payload: {}, maxAttempts: 5 },
      testDb.db
    )
    rosterImportAcknowledgements.recordAcknowledgement(
      seed.organizationId,
      {
        courseId: seed.courseId,
        accountId: seed.studentAccountId,
        filename: 'roster.csv',
        jobId: job.id,
        acknowledgementVersion: '2026-09-18',
        acknowledgedAt: Date.now(),
      },
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get(`/admin/accounts/${seed.studentAccountId}`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      rosterAcknowledgements: [
        {
          courseId: seed.courseId,
          courseTitle: 'Course A',
          organizationId: seed.organizationId,
          filename: 'roster.csv',
          acknowledgementVersion: '2026-09-18',
        },
      ],
    })
  })
})
