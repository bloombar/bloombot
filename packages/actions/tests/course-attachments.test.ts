/**
 * `courseAttachments.attach`/`.list`/`.detach` (FILE-1, FILE-2, FILE-3,
 * FILE-5) — proven against a real, throwaway database and a real, throwaway
 * `AttachmentStorage` directory under `tmp/` (never `data/`, QA-2, QA-3).
 * `apps/worker`'s own handler tests prove the provider side of FILE-1..3;
 * this file proves the action layer's own job: writing the bytes,
 * enqueueing exactly one job, and TEN-2/TEN-5 scoping.
 */

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  courseAttachments,
  courses,
  createFilesystemAttachmentStorage,
  jobs,
  projects,
  schema,
  type Database,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createAttachCourseAttachmentAction,
  detachCourseAttachmentAction,
  listCourseAttachmentsAction,
  MAX_COURSE_ATTACHMENTS_TOTAL_BYTES,
} from '../src/actions/course-attachments.js'
import { dispatch } from '../src/dispatch.js'
import {
  ActionConflictError,
  ActionInputError,
  ActionRefusedError,
} from '../src/errors.js'
import { seedOrganization } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

const STORAGE_ROOT = join(process.cwd(), 'tmp', 'actions-tests', 'attachments')

let testDb: TestDatabase
let storageDir: string

afterEach(() => {
  testDb.cleanup()
  rmSync(storageDir, { recursive: true, force: true })
})

function freshStorage() {
  storageDir = join(STORAGE_ROOT, randomUUID())
  return createFilesystemAttachmentStorage(storageDir)
}

/** One bare course, no categories — enough for these actions' own policies to resolve. */
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

function allJobRows(db: Database): jobs.Job[] {
  return db.select().from(schema.jobs).all()
}

describe('courseAttachments.attach (FILE-1)', () => {
  it('writes the decoded bytes to storage, records a pending attachment, and enqueues exactly one job', async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const before = allJobRows(testDb.db).length

    const action = createAttachCourseAttachmentAction(storage)
    const result = await dispatch(
      action,
      {
        courseId,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        contentBase64: Buffer.from('hello syllabus').toString('base64'),
      },
      { organizationId, db: testDb.db }
    )

    expect(result.attachmentId).toEqual(expect.any(String))
    expect(result.jobId).toEqual(expect.any(String))

    const row = courseAttachments.getAttachment(
      organizationId,
      result.attachmentId,
      testDb.db
    )
    expect(row).toMatchObject({
      status: 'pending',
      filename: 'syllabus.pdf',
      contentType: 'application/pdf',
      sizeBytes: 'hello syllabus'.length,
    })

    const bytes = await storage.read(organizationId, result.attachmentId)
    expect(bytes?.toString('utf8')).toBe('hello syllabus')

    const jobRows = allJobRows(testDb.db)
    expect(jobRows).toHaveLength(before + 1)
    const created = jobRows.find((row) => row.id === result.jobId)
    expect(created).toMatchObject({
      organizationId,
      kind: 'courseAttachments.attach',
      status: 'pending',
    })
    expect(JSON.parse(created?.payload ?? '{}')).toEqual({
      attachmentId: result.attachmentId,
    })
  })

  // Rework finding 11 — `Buffer.from(input.contentBase64, 'base64')`
  // silently *truncates* at the first character it cannot decode rather
  // than throwing, so an unvalidated `contentBase64` let malformed input
  // land as a corrupt, silently-shortened file on disk instead of being
  // refused as the bad input it actually was.
  it('refuses a malformed contentBase64 rather than silently storing a truncated file', async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const before = allJobRows(testDb.db).length

    const action = createAttachCourseAttachmentAction(storage)
    await expect(
      dispatch(
        action,
        {
          courseId,
          filename: 'syllabus.pdf',
          contentType: 'application/pdf',
          // Not valid base64 — `!` is outside the alphabet.
          contentBase64: 'not-valid-base64!!!',
        },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionInputError)

    // Refused before `execute` ever ran (ACT-4's own "validate" step) — no
    // bytes written, no row created, no job enqueued for it.
    expect(allJobRows(testDb.db)).toHaveLength(before)
  })

  it("refuses to attach to another organization's course", async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const courseId = seedCourse(organizationId, testDb.db)

    const action = createAttachCourseAttachmentAction(storage)
    await expect(
      dispatch(
        action,
        {
          courseId,
          filename: 'a.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('x').toString('base64'),
        },
        { organizationId: otherOrganizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseAttachments.attach — FILE-7 per-course budget', () => {
  /** Every subdirectory `AttachmentStorage` has actually written for this organization — `[]` when nothing has been written yet (no directory exists at all). */
  async function writtenAttachmentDirs(
    rootDir: string,
    organizationId: string
  ): Promise<string[]> {
    try {
      const { readdir } = await import('node:fs/promises')
      return await readdir(join(rootDir, organizationId))
    } catch {
      return []
    }
  }

  it('succeeds at exactly the budget', async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)

    // An existing pending attachment that already accounts for all but the
    // last 10 bytes of the budget — no real bytes need to be on disk for
    // it, since `totalSizeBytesForCourse` sums the row, not the filesystem.
    courseAttachments.createPendingAttachment(
      organizationId,
      {
        courseId,
        filename: 'existing.pdf',
        contentType: 'application/pdf',
        sizeBytes: MAX_COURSE_ATTACHMENTS_TOTAL_BYTES - 10,
      },
      testDb.db
    )

    const action = createAttachCourseAttachmentAction(storage)
    const result = await dispatch(
      action,
      {
        courseId,
        filename: 'last-bit.pdf',
        contentType: 'application/pdf',
        // Exactly 10 raw bytes — the course lands exactly at the budget,
        // not a byte over it.
        contentBase64: Buffer.from('0123456789').toString('base64'),
      },
      { organizationId, db: testDb.db }
    )

    expect(result.attachmentId).toEqual(expect.any(String))
    expect(
      courseAttachments.totalSizeBytesForCourse(
        organizationId,
        courseId,
        testDb.db
      )
    ).toBe(MAX_COURSE_ATTACHMENTS_TOTAL_BYTES)
  })

  it('refuses an attach that would exceed the budget, writing no storage bytes and no row', async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)

    courseAttachments.createPendingAttachment(
      organizationId,
      {
        courseId,
        filename: 'existing.pdf',
        contentType: 'application/pdf',
        sizeBytes: MAX_COURSE_ATTACHMENTS_TOTAL_BYTES - 5,
      },
      testDb.db
    )

    const rowsBefore = courseAttachments.listAttachmentsForCourse(
      organizationId,
      courseId,
      testDb.db
    ).length
    const dirsBefore = await writtenAttachmentDirs(storageDir, organizationId)

    const action = createAttachCourseAttachmentAction(storage)
    await expect(
      dispatch(
        action,
        {
          courseId,
          filename: 'one-too-many.pdf',
          contentType: 'application/pdf',
          // 6 raw bytes — one over the budget's own last 5.
          contentBase64: Buffer.from('012345').toString('base64'),
        },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionConflictError)

    // Refused before anything was written — the row count and the
    // storage directory are both untouched.
    const rowsAfter = courseAttachments.listAttachmentsForCourse(
      organizationId,
      courseId,
      testDb.db
    ).length
    expect(rowsAfter).toBe(rowsBefore)
    expect(await writtenAttachmentDirs(storageDir, organizationId)).toEqual(
      dirsBefore
    )
  })

  it('refuses with a message naming the budget and what is already used', async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)

    courseAttachments.createPendingAttachment(
      organizationId,
      {
        courseId,
        filename: 'existing.pdf',
        contentType: 'application/pdf',
        sizeBytes: MAX_COURSE_ATTACHMENTS_TOTAL_BYTES,
      },
      testDb.db
    )

    const action = createAttachCourseAttachmentAction(storage)
    let caught: unknown
    try {
      await dispatch(
        action,
        {
          courseId,
          filename: 'too-much.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('x').toString('base64'),
        },
        { organizationId, db: testDb.db }
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ActionConflictError)
    expect((caught as ActionConflictError).message).toBe(
      'That file would put this course over its 100 MB total. 100 MB of 100 MB is already used.'
    )
  })

  it('counts a pending row toward the total exactly the same as a ready one', async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)

    // Still `pending` — never marked `ready` — but its bytes are already
    // spent (FILE-5's own "the bytes land before the row does"), so it must
    // count against the budget exactly as a `ready` row would.
    courseAttachments.createPendingAttachment(
      organizationId,
      {
        courseId,
        filename: 'still-pending.pdf',
        contentType: 'application/pdf',
        sizeBytes: MAX_COURSE_ATTACHMENTS_TOTAL_BYTES,
      },
      testDb.db
    )

    const action = createAttachCourseAttachmentAction(storage)
    await expect(
      dispatch(
        action,
        {
          courseId,
          filename: 'anything.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('x').toString('base64'),
        },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionConflictError)
  })
})

describe('courseAttachments.list (FILE-2)', () => {
  it("lists only a course's own attachments", async () => {
    testDb = createTestDatabase()
    const storage = freshStorage()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const attach = createAttachCourseAttachmentAction(storage)
    await dispatch(
      attach,
      {
        courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        contentBase64: Buffer.from('a').toString('base64'),
      },
      { organizationId, db: testDb.db }
    )

    const listed = await dispatch(
      listCourseAttachmentsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )
    expect(listed).toHaveLength(1)
    expect(listed[0]?.filename).toBe('a.pdf')
  })
})

describe('courseAttachments.detach (FILE-3, FILE-5)', () => {
  it('enqueues a detach job naming the attachment', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const attachment = courseAttachments.createPendingAttachment(
      organizationId,
      {
        courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )

    const result = await dispatch(
      detachCourseAttachmentAction,
      { attachmentId: attachment.id },
      { organizationId, db: testDb.db }
    )

    expect(result.jobId).toEqual(expect.any(String))
    const jobRow = jobs.getJob(organizationId, result.jobId, testDb.db)
    expect(jobRow).toMatchObject({ kind: 'courseAttachments.detach' })
    expect(JSON.parse(jobRow?.payload ?? '{}')).toEqual({
      attachmentId: attachment.id,
    })
  })

  // FILE-5: another organization's attachment is not readable, listable or
  // detachable — identical not-found.
  it("another organization's attachment is not listable or detachable — identical not-found", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')
    const courseId = seedCourse(organizationId, testDb.db)
    const attachment = courseAttachments.createPendingAttachment(
      organizationId,
      {
        courseId,
        filename: 'secret.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )

    await expect(
      dispatch(
        detachCourseAttachmentAction,
        { attachmentId: attachment.id },
        { organizationId: otherOrganizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)

    await expect(
      dispatch(
        listCourseAttachmentsAction,
        { courseId },
        { organizationId: otherOrganizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)

    // Both refusals are byte-identical (ACT-3) — the same not-found shape a
    // genuinely missing id would produce.
    let listedRefusal: unknown
    let detachRefusal: unknown
    try {
      await dispatch(
        listCourseAttachmentsAction,
        { courseId },
        { organizationId: otherOrganizationId, db: testDb.db }
      )
    } catch (error) {
      listedRefusal = error
    }
    try {
      await dispatch(
        detachCourseAttachmentAction,
        { attachmentId: attachment.id },
        { organizationId: otherOrganizationId, db: testDb.db }
      )
    } catch (error) {
      detachRefusal = error
    }
    expect((listedRefusal as Error).message).toBe(
      (detachRefusal as Error).message
    )
  })
})
