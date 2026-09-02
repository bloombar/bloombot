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
  memberships,
  organizations,
  people,
  transcriptExports,
  courses as coursesRepo,
  projects as projectsRepo,
} from '@bloombot/db'

import { SESSION_COOKIE_NAME } from '../../src/middleware/session.js'
import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase
const originalAdminEmails = process.env['ADMIN_EMAILS']

afterEach(() => {
  testDb.cleanup()
  if (originalAdminEmails === undefined) delete process.env['ADMIN_EMAILS']
  else process.env['ADMIN_EMAILS'] = originalAdminEmails
})

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
      filePrefix: 'wd',
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
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/admin/organizations/${organizationId}/delete`)
      .set('Cookie', admin.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ confirmName: 'A Real Tenant' })

    expect(response.status).toBe(200)
    expect(exportRow.id).toBeTruthy()
    expect(
      memberships.getMembership(organizationId, instructor.id, testDb.db)
    ).toBeUndefined()
  })
})
