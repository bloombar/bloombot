/**
 * FILE-1 — a rework finding: `courseAttachments.attach`'s payload carries a
 * course file as base64 in the JSON body (`packages/actions/src/actions/course-attachments.ts`'s
 * own module comment has why a reference is not the shape either), but this
 * route used to rely entirely on `server.ts`'s global `express.json()`,
 * which defaults to 100 kB — base64's 4/3 inflation makes that a ~74 kB
 * *raw file* ceiling, well under a real syllabus, notes or schedule file
 * (FILE-1's own text names all three). `ACTION_JSON_BODY_LIMIT_BYTES`
 * (`../../src/routes/actions.ts`) is this route's own explicit, tested
 * ceiling, raised only for this one path prefix — proven two ways here: a
 * file well over the old default is now accepted, and a body over the new,
 * explicit ceiling is still refused rather than accidentally unbounded.
 */

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { courses, projects, type Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { ACTION_JSON_BODY_LIMIT_BYTES } from '../../src/routes/actions.js'
import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

// A dedicated, per-test `tmp/` subdirectory (never `data/`, QA-2/QA-3) —
// removed in `afterEach` the same way `packages/db/tests/attachment-storage.test.ts`
// cleans up its own throwaway `rootDir`, so a run of this file leaves
// nothing behind it.
const ATTACHMENT_TMP_ROOT = join(
  process.cwd(),
  'tmp',
  'api-tests',
  'course-attachments-body-limit'
)

let testDb: TestDatabase
let attachmentStorageDir: string

afterEach(() => {
  testDb.cleanup()
  rmSync(attachmentStorageDir, { recursive: true, force: true })
})

/** One bare, enabled course the signed-in caller's own organization can attach a file to. */
function seedCourse(organizationId: string, db: Database): string {
  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )
  const result = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: 'admins-tc',
      studentsRole: 'students-tc',
      categories: [],
    },
    db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return result.course.id
}

describe("FILE-1 — courseAttachments.attach's own raised body limit", () => {
  it("accepts a ~300 KB file — well over express.json()'s ordinary 100 kB default", async () => {
    testDb = createTestDatabase()
    attachmentStorageDir = join(ATTACHMENT_TMP_ROOT, randomUUID())
    const caller = seedSignedInCaller(testDb.db)
    const courseId = seedCourse(caller.organizationId, testDb.db)
    const app = await buildTestApp(testDb.db, { attachmentStorageDir })

    // Raw bytes, not the base64 form — the request body (base64 plus this
    // action's other fields and JSON's own quoting) is larger still, which
    // is exactly the 4/3 inflation this route's own doc comment accounts
    // for.
    const contentBase64 = Buffer.alloc(300 * 1024, 'a').toString('base64')

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/actions/courseAttachments.attach`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({
        courseId,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        contentBase64,
      })

    expect(response.status).toBe(200)
  })

  it('still refuses (413) a body over the explicit ceiling itself, so the raised limit is a real bound, not accidentally unbounded', async () => {
    testDb = createTestDatabase()
    attachmentStorageDir = join(ATTACHMENT_TMP_ROOT, randomUUID())
    const caller = seedSignedInCaller(testDb.db)
    const courseId = seedCourse(caller.organizationId, testDb.db)
    const app = await buildTestApp(testDb.db, { attachmentStorageDir })

    // Comfortably over `ACTION_JSON_BODY_LIMIT_BYTES` — content, not a
    // real base64 encoding (a malformed value never reaches this check;
    // body-parser refuses on raw byte size alone, before anything reads
    // the body as JSON).
    const oversizedContent = 'a'.repeat(
      ACTION_JSON_BODY_LIMIT_BYTES + 1024 * 1024
    )

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/actions/courseAttachments.attach`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({
        courseId,
        filename: 'too-big.pdf',
        contentType: 'application/pdf',
        contentBase64: oversizedContent,
      })

    expect(response.status).toBe(413)
  }, 30000)
})
