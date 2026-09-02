/**
 * `transcripts.export` (ADMIN-3) — against a real, throwaway database and a
 * throwaway `AttachmentStorage` directory. Each test below fails without
 * this slice's code: before it, this handler did not exist, and
 * `apps/worker` registered no `transcripts.export` job kind at all.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import {
  accounts,
  conversations,
  createFilesystemAttachmentStorage,
  jobs,
  organizations,
  people,
  projects,
  schema,
  transcriptAccess,
  transcriptExports,
  courses as coursesRepo,
  type Database,
} from '@bloombot/db'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createTranscriptExportHandler,
  TRANSCRIPT_EXPORT_JOB_KIND,
} from '../../src/handlers/transcripts.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

const STORAGE_ROOT = join(
  process.cwd(),
  'tmp',
  'worker-tests',
  'transcript-exports'
)

let testDb: TestDatabase
let storageDir: string

afterEach(() => {
  testDb.cleanup()
  rmSync(storageDir, { recursive: true, force: true })
})

const retryPolicy: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

/** One organization, one course, one instructor and one student with a message. */
function seedCourseWithTranscript(db: Database) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    db
  )
  const project = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    db
  )
  const courseResult = coursesRepo.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: 'course-admins',
      studentsRole: 'course-students',
      categories: [],
    },
    db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  const instructor = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Instructor',
      role: 'owner',
    },
    db
  )
  const student = people.createPerson(
    organizationId,
    { displayName: 'Student' },
    db
  )
  const conversation = conversations.getOrCreateConversation(
    organizationId,
    { courseId: courseResult.course.id, personId: student.id, surface: 'web' },
    db
  )
  if (!conversation) throw new Error('seed conversation creation failed')
  conversations.appendMessage(
    organizationId,
    conversation.id,
    { direction: 'from_person', content: 'When is office hours?' },
    db
  )

  return { organizationId, course: courseResult.course, instructor, student }
}

async function setUp() {
  testDb = createTestDatabase()
  storageDir = join(STORAGE_ROOT, randomUUID())
  mkdirSync(storageDir, { recursive: true })
  return createFilesystemAttachmentStorage(storageDir)
}

describe('transcripts.export handler (ADMIN-3)', () => {
  it('produces a file, marks the export ready, and writes the ADMIN-2 audit entry', async () => {
    const storage = await setUp()
    const { organizationId, course, instructor } = seedCourseWithTranscript(
      testDb.db
    )
    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      { courseId: course.id, requestedByAccountId: instructor.id },
      testDb.db
    )
    const job = jobs.enqueueJob(
      organizationId,
      {
        kind: TRANSCRIPT_EXPORT_JOB_KIND,
        payload: { exportId: exportRow.id },
        maxAttempts: 3,
      },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register(
      TRANSCRIPT_EXPORT_JOB_KIND,
      createTranscriptExportHandler({ attachmentStorage: storage })
    )
    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 30_000,
      handlerTimeoutMs: 5_000,
      retryPolicy,
    })

    expect(result.outcome).toBe('succeeded')
    const ready = transcriptExports.getExport(
      organizationId,
      exportRow.id,
      testDb.db
    )
    expect(ready?.status).toBe('ready')
    expect(ready?.contentType).toBe('application/json')
    expect(ready?.sizeBytes).toBeGreaterThan(0)

    const bytes = await storage.read(organizationId, exportRow.id)
    expect(bytes).toBeDefined()
    const parsed = JSON.parse(bytes?.toString('utf8') ?? '{}') as {
      transcript: { content: string }[]
    }
    expect(parsed.transcript).toHaveLength(1)
    expect(parsed.transcript[0]?.content).toBe('When is office hours?')

    // ADMIN-2 / ADMIN-3 — the export's own read went through the same
    // audited function an on-screen read does.
    const log = transcriptAccess.listAccessLogForCourse(
      organizationId,
      course.id,
      testDb.db
    )
    expect(log).toHaveLength(1)
    expect(log[0]?.kind).toBe('export')

    expect(job.id).toBeTruthy()
  })

  it('marks the export failed, permanently, when the course no longer exists', async () => {
    const storage = await setUp()
    const { organizationId, course, instructor } = seedCourseWithTranscript(
      testDb.db
    )
    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      { courseId: course.id, requestedByAccountId: instructor.id },
      testDb.db
    )
    const job = jobs.enqueueJob(
      organizationId,
      {
        kind: TRANSCRIPT_EXPORT_JOB_KIND,
        payload: { exportId: exportRow.id },
        maxAttempts: 3,
      },
      testDb.db
    )

    // Simulate the course having vanished by the time the job runs — the
    // handler's own `readCourseTranscript` call then resolves `undefined`.
    // `transcript_exports.course_id` is itself foreign-keyed to `courses`
    // (so this can never happen through this platform's own repo
    // functions — ADMIN-5's tenant deletion removes the export row in the
    // same transaction as the course), so this test drops to the raw
    // connection, with FK enforcement briefly off, purely to exercise this
    // handler's own defensive branch.
    testDb.db.$client.pragma('foreign_keys = OFF')
    testDb.db
      .delete(schema.courses)
      .where(eq(schema.courses.id, course.id))
      .run()
    testDb.db.$client.pragma('foreign_keys = ON')

    const handlers = new HandlerRegistry()
    handlers.register(
      TRANSCRIPT_EXPORT_JOB_KIND,
      createTranscriptExportHandler({ attachmentStorage: storage })
    )
    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 30_000,
      handlerTimeoutMs: 5_000,
      retryPolicy,
    })

    // `permanent: true` — failed on the first attempt, not retried, even
    // though `maxAttempts: 3` left room to.
    expect(result.outcome).toBe('failed')
    const failed = transcriptExports.getExport(
      organizationId,
      exportRow.id,
      testDb.db
    )
    expect(failed?.status).toBe('failed')
    expect(failed?.failureReason).toBeTruthy()
    expect(job.id).toBeTruthy()
  })
})
