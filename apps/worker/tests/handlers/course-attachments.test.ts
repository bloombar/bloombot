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
    expect(updated?.providerFileId).toBeNull()
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
