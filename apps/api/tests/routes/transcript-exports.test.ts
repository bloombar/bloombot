/**
 * ADMIN-3's own "collect the file when it is ready" — downloading a
 * produced export, over HTTP. `routes/transcript-exports.ts` was proven
 * tenant-isolated by `tests/tenant-isolation.test.ts`'s own sweep (a/b/c —
 * a foreign session, no session, a disabled account), but nothing there
 * ever asks for a *real* file back — this file is what proves a real
 * download actually works, that a pending export refuses cleanly, and that
 * the bytes served are exactly the bytes `AttachmentStorage` holds.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import {
  createFilesystemAttachmentStorage,
  transcriptExports,
  courses as coursesRepo,
  projects as projectsRepo,
} from '@bloombot/db'

import {
  buildTestApp,
  TEST_ATTACHMENT_STORAGE_DIR,
  TEST_PUBLIC_APP_URL,
} from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization, one signed-in member, one course — enough for an export row to attach to. */
function seedCallerWithCourse(db: TestDatabase['db']) {
  const caller = seedSignedInCaller(db)
  const project = projectsRepo.createProject(
    caller.organizationId,
    { name: 'Fall 2026' },
    db
  )
  const courseResult = coursesRepo.createCourse(
    caller.organizationId,
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
  if (!courseResult.ok) throw new Error('setup failed: course not saved')
  return { caller, courseId: courseResult.course.id }
}

describe('GET /organizations/:organizationId/transcript-exports/:exportId/download (ADMIN-3)', () => {
  it('serves the exact bytes AttachmentStorage holds, with the export’s own content type and filename', async () => {
    testDb = createTestDatabase()
    const { caller, courseId } = seedCallerWithCourse(testDb.db)
    const exportRow = transcriptExports.createPendingExport(
      caller.organizationId,
      { courseId, requestedByAccountId: caller.accountId },
      testDb.db
    )
    const attachmentStorage = createFilesystemAttachmentStorage(
      TEST_ATTACHMENT_STORAGE_DIR
    )
    const fileBytes = Buffer.from('{"transcript":["hello"]}')
    await attachmentStorage.write(
      caller.organizationId,
      exportRow.id,
      fileBytes
    )
    transcriptExports.markExportReady(
      caller.organizationId,
      exportRow.id,
      {
        filename: `transcript-export-${exportRow.id}.json`,
        contentType: 'application/json',
        sizeBytes: fileBytes.byteLength,
      },
      testDb.db
    )

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(
        `/organizations/${caller.organizationId}/transcript-exports/${exportRow.id}/download`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-disposition']).toContain(
      `transcript-export-${exportRow.id}.json`
    )
    expect(response.body).toEqual(JSON.parse(fileBytes.toString()))
  })

  it('refuses a pending export with 409 export_not_ready, not a partial or empty download', async () => {
    testDb = createTestDatabase()
    const { caller, courseId } = seedCallerWithCourse(testDb.db)
    const exportRow = transcriptExports.createPendingExport(
      caller.organizationId,
      { courseId, requestedByAccountId: caller.accountId },
      testDb.db
    )

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(
        `/organizations/${caller.organizationId}/transcript-exports/${exportRow.id}/download`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'export_not_ready' })
  })

  it('refuses an export id that does not exist, the same not-found shape as a foreign one (TEN-5)', async () => {
    testDb = createTestDatabase()
    const { caller } = seedCallerWithCourse(testDb.db)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .get(
        `/organizations/${caller.organizationId}/transcript-exports/${randomUUID()}/download`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'action_refused' })
  })
})
