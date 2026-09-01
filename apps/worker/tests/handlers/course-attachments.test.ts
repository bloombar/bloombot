/**
 * `courseAttachments.attach`/`.detach` (FILE-1..3) — against a real,
 * throwaway database, a throwaway `AttachmentStorage` directory, and a
 * loopback fake standing in for OpenAI's Files/Vector Stores endpoints
 * (`FakeOpenAiFilesServer`). Each test below fails without this slice's
 * code: before it, neither handler existed, and `apps/worker` registered no
 * `courseAttachments.*` job kind at all.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  courseAttachments,
  courses,
  createFilesystemAttachmentStorage,
  jobs,
} from '@bloombot/db'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import type { FilesHttpOptions } from '@bloombot/openai'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ATTACH_COURSE_ATTACHMENT_JOB_KIND,
  createAttachCourseAttachmentHandler,
  createDetachCourseAttachmentHandler,
} from '../../src/handlers/course-attachments.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { FakeOpenAiFilesServer } from '../helpers/fake-openai-files-server.js'
import { seedOrganizationWithBoundCourse } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

const STORAGE_ROOT = join(process.cwd(), 'tmp', 'worker-tests', 'attachments')

let testDb: TestDatabase
let openaiServer: FakeOpenAiFilesServer
let storageDir: string

afterEach(async () => {
  testDb.cleanup()
  await openaiServer.stop()
  rmSync(storageDir, { recursive: true, force: true })
})

const retryPolicy: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

async function setUp() {
  testDb = createTestDatabase()
  openaiServer = await FakeOpenAiFilesServer.start()
  storageDir = join(STORAGE_ROOT, randomUUID())
  mkdirSync(storageDir, { recursive: true })
  const storage = createFilesystemAttachmentStorage(storageDir)
  const openaiHttpOptions: FilesHttpOptions = {
    fetchFn: fetch,
    baseUrl: openaiServer.baseUrl,
    apiKey: 'test-key',
    timeoutMs: 2000,
  }
  return { storage, openaiHttpOptions }
}

describe('courseAttachments.attach handler', () => {
  // FILE-1: end to end through the queue — attach a file, run one worker
  // pass, the attachment is ready and carries the provider's id.
  it('attach a file, run one worker pass, and the attachment is ready carrying the providers id', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'placeholder', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'placeholder',
        courseId: seeded.courseId,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    openaiServer.respondToFiles({ status: 200, body: { id: 'file_123' } })
    openaiServer.respondToVectorStoreCreate({
      status: 200,
      body: { id: 'vs_123' },
    })
    openaiServer.respondToVectorStoreFileAttach({
      status: 200,
      body: { status: 'completed' },
    })

    const handlers = new HandlerRegistry()
    handlers.register(
      ATTACH_COURSE_ATTACHMENT_JOB_KIND,
      createAttachCourseAttachmentHandler({
        openaiHttpOptions,
        attachmentStorage: storage,
      })
    )
    jobs.enqueueJob(
      seeded.organizationId,
      {
        kind: ATTACH_COURSE_ATTACHMENT_JOB_KIND,
        payload: { attachmentId: attachment.id },
        maxAttempts: 3,
      },
      testDb.db
    )

    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result.outcome).toBe('succeeded')
    const updated = courseAttachments.getAttachment(
      seeded.organizationId,
      attachment.id,
      testDb.db
    )
    expect(updated?.status).toBe('ready')
    expect(updated?.providerFileId).toBe('file_123')

    const course = courses.getCourse(
      seeded.organizationId,
      seeded.courseId,
      testDb.db
    )
    expect(course?.vectorStoreId).toBe('vs_123')
  })

  it("reuses the course's own hand-typed vector store id instead of creating one", async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    courses.updateCourse(
      seeded.organizationId,
      seeded.courseId,
      {
        projectId: courses.getCourse(
          seeded.organizationId,
          seeded.courseId,
          testDb.db
        )!.projectId,
        title: 'Test Course',
        filePrefix: 'tc',
        enabled: true,
        adminsRole: seeded.adminsRole,
        studentsRole: seeded.studentsRole,
        vectorStoreId: 'vs_hand_typed',
        categories: [],
      },
      testDb.db
    )
    await storage.write(seeded.organizationId, 'att-1', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-1',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    openaiServer.respondToFiles({ status: 200, body: { id: 'file_1' } })
    openaiServer.respondToVectorStoreFileAttach({
      status: 200,
      body: { status: 'completed' },
    })

    const handler = createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    await handler(
      { attachmentId: attachment.id },
      {
        organizationId: seeded.organizationId,
        jobId: randomUUID(),
        attempts: 1,
        db: testDb.db,
        logger: createFakeLogger(),
      }
    )

    // No POST /vector_stores at all — the hand-typed id was reused.
    expect(
      openaiServer.requests.filter(
        (r) => r.method === 'POST' && r.path === '/vector_stores'
      )
    ).toHaveLength(0)
    expect(
      openaiServer.requests.some(
        (r) => r.path === '/vector_stores/vs_hand_typed/files'
      )
    ).toBe(true)
    const course = courses.getCourse(
      seeded.organizationId,
      seeded.courseId,
      testDb.db
    )
    expect(course?.vectorStoreId).toBe('vs_hand_typed')
  })

  // FILE-2: a provider rejection leaves the attachment failed with the
  // reason, and the course is never left looking configured.
  it('FILE-2: a provider rejection leaves the attachment failed with the reason, and the course is not left looking configured', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-2', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-2',
        courseId: seeded.courseId,
        filename: 'bad.exe',
        contentType: 'application/octet-stream',
        sizeBytes: 1,
      },
      testDb.db
    )
    openaiServer.respondToFiles({ status: 200, body: { id: 'file_bad' } })
    openaiServer.respondToVectorStoreCreate({
      status: 200,
      body: { id: 'vs_new' },
    })
    openaiServer.respondToVectorStoreFileAttach({
      status: 200,
      body: {
        status: 'failed',
        last_error: { message: 'unsupported file format' },
      },
    })

    const handler = createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    const report = await handler(
      { attachmentId: attachment.id },
      {
        organizationId: seeded.organizationId,
        jobId: randomUUID(),
        attempts: 1,
        db: testDb.db,
        logger: createFakeLogger(),
      }
    )

    expect(report).toEqual({
      attachmentId: attachment.id,
      status: 'failed',
      reason: 'unsupported file format',
    })
    // What the panel would see: the row itself says failed, with the reason.
    const updated = courseAttachments.getAttachment(
      seeded.organizationId,
      attachment.id,
      testDb.db
    )
    expect(updated?.status).toBe('failed')
    expect(updated?.failureReason).toBe('unsupported file format')
    // Rework finding 5 — the upload itself succeeded, so `providerFileId`
    // is recorded even though the attach that followed it was rejected:
    // without this, `courseAttachments.detach` would have nothing to reach
    // on the provider, and this uploaded file would sit there forever.
    expect(updated?.providerFileId).toBe('file_bad')
    // The course must never look configured while this attachment is
    // ungrounded — its vectorStoreId stays null even though a store was
    // created upstream.
    const course = courses.getCourse(
      seeded.organizationId,
      seeded.courseId,
      testDb.db
    )
    expect(course?.vectorStoreId).toBeNull()
  })

  // Scoping: a job payload naming another organization's attachment is
  // refused by the repo layer.
  it("refuses a payload naming another organization's attachment", async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    const otherOrg = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-3', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-3',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )

    const handler = createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    await expect(
      handler(
        { attachmentId: attachment.id },
        {
          organizationId: otherOrg.organizationId,
          jobId: randomUUID(),
          attempts: 1,
          db: testDb.db,
          logger: createFakeLogger(),
        }
      )
    ).rejects.toThrow(/was not found in this organization/)
  })

  // Rework finding 4: the original only guarded the upload (step 2) — a
  // non-retryable rejection from attaching to the vector store (step 4;
  // the same shape a hand-typed `vectorStoreId` that 404s produces) used to
  // propagate uncaught, leaving the row `pending` with no reason.
  it('rework finding 4: a non-retryable rejection attaching to the vector store marks the attachment failed, not only a rejected upload', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    courses.updateCourse(
      seeded.organizationId,
      seeded.courseId,
      {
        projectId: courses.getCourse(
          seeded.organizationId,
          seeded.courseId,
          testDb.db
        )!.projectId,
        title: 'Test Course',
        filePrefix: 'tc',
        enabled: true,
        adminsRole: seeded.adminsRole,
        studentsRole: seeded.studentsRole,
        // A hand-typed id (D-3's escape hatch) that no longer resolves on
        // the provider — the obvious real-world way step 4 rejects
        // non-retryably without step 2 (the upload) having done anything
        // wrong at all.
        vectorStoreId: 'vs_stale',
        categories: [],
      },
      testDb.db
    )
    await storage.write(seeded.organizationId, 'att-8', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-8',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    openaiServer.respondToFiles({ status: 200, body: { id: 'file_8' } })
    openaiServer.respondToVectorStoreFileAttach({
      status: 404,
      body: { error: { message: 'no such vector store' } },
    })

    const handler = createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    const report = await handler(
      { attachmentId: attachment.id },
      {
        organizationId: seeded.organizationId,
        jobId: randomUUID(),
        attempts: 1,
        db: testDb.db,
        logger: createFakeLogger(),
      }
    )

    expect(report).toEqual({
      attachmentId: attachment.id,
      status: 'failed',
      reason: 'no such vector store',
    })
    const updated = courseAttachments.getAttachment(
      seeded.organizationId,
      attachment.id,
      testDb.db
    )
    expect(updated?.status).toBe('failed')
    expect(updated?.failureReason).toBe('no such vector store')
    // Rework finding 5 — the upload itself succeeded before the rejection,
    // so the provider's own file id is still recorded rather than
    // discarded.
    expect(updated?.providerFileId).toBe('file_8')
  })

  // Rework finding 3: a transient failure that keeps failing through every
  // retry used to leave the row `pending` forever once JOB-2 (the queue
  // itself, `@bloombot/jobs`) finally gave up — no way for a caller to tell
  // "still working" from "dead".
  it('rework finding 3: a transient failure on the last attempt also marks the attachment failed, not just the job', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-9', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-9',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    // A 503 from the upload itself — retryable (MDL-5).
    openaiServer.respondToFiles({
      status: 503,
      body: { error: { message: 'temporarily unavailable' } },
    })

    const handler = createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    await expect(
      handler(
        { attachmentId: attachment.id },
        {
          organizationId: seeded.organizationId,
          jobId: randomUUID(),
          attempts: 3,
          maxAttempts: 3,
          db: testDb.db,
          logger: createFakeLogger(),
        }
      )
      // Still propagates — the job row's own terminal state (JOB-2) is
      // `runNextJob`'s concern, not this handler's; this only adds the
      // attachment's own terminal state alongside it.
    ).rejects.toThrow()

    const updated = courseAttachments.getAttachment(
      seeded.organizationId,
      attachment.id,
      testDb.db
    )
    expect(updated?.status).toBe('failed')
    expect(updated?.failureReason).toMatch(/gave up after 3 attempt/)
  })

  // The other half of the same finding: a transient failure that is *not*
  // yet on the last attempt must not be marked failed early — that would
  // show "dead" for an attachment that is, truthfully, still retrying.
  it('a transient failure before the last attempt leaves the attachment pending, still retryable', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-10', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-10',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    openaiServer.respondToFiles({
      status: 503,
      body: { error: { message: 'temporarily unavailable' } },
    })

    const handler = createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    await expect(
      handler(
        { attachmentId: attachment.id },
        {
          organizationId: seeded.organizationId,
          jobId: randomUUID(),
          attempts: 1,
          maxAttempts: 3,
          db: testDb.db,
          logger: createFakeLogger(),
        }
      )
    ).rejects.toThrow()

    const updated = courseAttachments.getAttachment(
      seeded.organizationId,
      attachment.id,
      testDb.db
    )
    expect(updated?.status).toBe('pending')
    expect(updated?.failureReason).toBeNull()
  })

  // Rework finding 6: a concurrent detach that removes the row mid-flight
  // must not be overwritten back into existence as "ready", and must not
  // leave `courses.vectorStoreId` pointing at a file nothing local records.
  it('rework finding 6: a concurrent detach mid-flight reports abandoned, and leaves courses.vectorStoreId untouched', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-11', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-11',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    openaiServer.respondToFiles({ status: 200, body: { id: 'file_11' } })
    openaiServer.respondToVectorStoreCreate({
      status: 200,
      body: { id: 'vs_11' },
    })
    // Simulates a concurrent `courseAttachments.detach` completing while
    // this attach's own "attach to vector store" call was still in flight
    // — the response for that call still arrives (`completed`), but the row
    // it would have marked ready is already gone.
    openaiServer.respondToVectorStoreFileAttach(() => {
      courseAttachments.deleteAttachment(
        seeded.organizationId,
        attachment.id,
        testDb.db
      )
      return { status: 200, body: { status: 'completed' } }
    })

    const handler = createAttachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    const report = await handler(
      { attachmentId: attachment.id },
      {
        organizationId: seeded.organizationId,
        jobId: randomUUID(),
        attempts: 1,
        db: testDb.db,
        logger: createFakeLogger(),
      }
    )

    expect(report).toEqual({
      attachmentId: attachment.id,
      status: 'abandoned',
      reason:
        'the attachment was removed (a concurrent detach) before this attach completed',
    })
    const course = courses.getCourse(
      seeded.organizationId,
      seeded.courseId,
      testDb.db
    )
    expect(course?.vectorStoreId).toBeNull()
  })
})

describe('courseAttachments.detach handler', () => {
  // FILE-3: detaching reaches the provider and the attachment stops
  // grounding answers.
  it('reaches the provider, then removes the bytes and the row', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-4', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-4',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    courses.updateCourse(
      seeded.organizationId,
      seeded.courseId,
      {
        projectId: courses.getCourse(
          seeded.organizationId,
          seeded.courseId,
          testDb.db
        )!.projectId,
        title: 'Test Course',
        filePrefix: 'tc',
        enabled: true,
        adminsRole: seeded.adminsRole,
        studentsRole: seeded.studentsRole,
        vectorStoreId: 'vs_1',
        categories: [],
      },
      testDb.db
    )
    courseAttachments.markAttachmentReady(
      seeded.organizationId,
      attachment.id,
      'file_1',
      testDb.db
    )

    const handler = createDetachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    const report = await handler(
      { attachmentId: attachment.id },
      {
        organizationId: seeded.organizationId,
        jobId: randomUUID(),
        attempts: 1,
        db: testDb.db,
        logger: createFakeLogger(),
      }
    )

    expect(report).toEqual({ attachmentId: attachment.id, detached: true })
    // The fake received the delete — both halves (FILE-3's own text).
    expect(
      openaiServer.requests.some(
        (r) =>
          r.method === 'DELETE' && r.path === '/vector_stores/vs_1/files/file_1'
      )
    ).toBe(true)
    expect(
      openaiServer.requests.some(
        (r) => r.method === 'DELETE' && r.path === '/files/file_1'
      )
    ).toBe(true)
    // No longer grounding anything, from the panel's own point of view: the
    // row is gone, and so are its bytes.
    expect(
      courseAttachments.getAttachment(
        seeded.organizationId,
        attachment.id,
        testDb.db
      )
    ).toBeUndefined()
    expect(
      await storage.read(seeded.organizationId, attachment.id)
    ).toBeUndefined()
  })

  // Rework finding 2: a 404 from either provider delete means "already
  // gone" (an earlier attempt's own delete actually landed, but timed out
  // before this handler heard back — the ordinary at-least-once retry
  // shape), not a failure. Without this, both fake responses below would
  // throw an uncaught `client_error`, the local removal would never run,
  // and this attachment would stay `ready`, its bytes still on disk,
  // permanently undeletable.
  it('rework finding 2: a 404 from a provider delete is treated as already gone, and the local removal still completes', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-6', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-6',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )
    courses.updateCourse(
      seeded.organizationId,
      seeded.courseId,
      {
        projectId: courses.getCourse(
          seeded.organizationId,
          seeded.courseId,
          testDb.db
        )!.projectId,
        title: 'Test Course',
        filePrefix: 'tc',
        enabled: true,
        adminsRole: seeded.adminsRole,
        studentsRole: seeded.studentsRole,
        vectorStoreId: 'vs_2',
        categories: [],
      },
      testDb.db
    )
    courseAttachments.markAttachmentReady(
      seeded.organizationId,
      attachment.id,
      'file_2',
      testDb.db
    )
    // Both provider deletes 404 — as if an earlier attempt at this same
    // detach already reached the provider and removed them, and this run
    // is the retry that follows.
    openaiServer.respondToVectorStoreFileDelete({
      status: 404,
      body: { error: { message: 'no such file in vector store' } },
    })
    openaiServer.respondToFileDelete({
      status: 404,
      body: { error: { message: 'no such file' } },
    })

    const handler = createDetachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    const report = await handler(
      { attachmentId: attachment.id },
      {
        organizationId: seeded.organizationId,
        jobId: randomUUID(),
        attempts: 2,
        db: testDb.db,
        logger: createFakeLogger(),
      }
    )

    expect(report).toEqual({ attachmentId: attachment.id, detached: true })
    expect(
      courseAttachments.getAttachment(
        seeded.organizationId,
        attachment.id,
        testDb.db
      )
    ).toBeUndefined()
    expect(
      await storage.read(seeded.organizationId, attachment.id)
    ).toBeUndefined()
  })

  it('a never-uploaded (pending) attachment is removed locally without any provider call', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const seeded = seedOrganizationWithBoundCourse(testDb.db, [])
    await storage.write(seeded.organizationId, 'att-5', Buffer.from('x'))
    const attachment = courseAttachments.createPendingAttachment(
      seeded.organizationId,
      {
        id: 'att-5',
        courseId: seeded.courseId,
        filename: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      },
      testDb.db
    )

    const handler = createDetachCourseAttachmentHandler({
      openaiHttpOptions,
      attachmentStorage: storage,
    })
    await handler(
      { attachmentId: attachment.id },
      {
        organizationId: seeded.organizationId,
        jobId: randomUUID(),
        attempts: 1,
        db: testDb.db,
        logger: createFakeLogger(),
      }
    )

    expect(openaiServer.requests).toHaveLength(0)
    expect(
      courseAttachments.getAttachment(
        seeded.organizationId,
        attachment.id,
        testDb.db
      )
    ).toBeUndefined()
  })
})
