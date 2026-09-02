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
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  // Verified — a `web` identity, the only proxy this platform has for one
  // (`people.ts#hasVerifiedAddress`'s own doc comment) — so every test that
  // reuses this helper and expects to see this student's own message
  // survive export (PPL-5's own per-entry filter, `apps/worker/src/handlers/
  // transcripts.ts`) gets that for free; the *unverified* case has its own
  // dedicated test and seeds its own person, below.
  const student = people.resolvePersonByIdentity(
    organizationId,
    { surface: 'web', externalId: randomUUID() },
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

  // Must-fix 1 — ADMIN-5's own race with `routes/admin.ts`'s tenant
  // deletion: the export row named by this job's own payload is removed
  // (a concurrent tenant deletion) in the narrow window after this handler
  // has already read the transcript back, but before it writes the file.
  // `getExport` is spied on to make that window land deterministically —
  // the first call (this handler's own initial resolve) returns the real
  // row; the second (the re-check immediately before the write) returns
  // `undefined`, exactly what a real concurrent delete would leave it
  // returning.
  it('writes no bytes, and reports abandoned, when the export is deleted between reading the transcript and writing the file', async () => {
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

    const realGetExport = transcriptExports.getExport
    let calls = 0
    const getExportSpy = vi
      .spyOn(transcriptExports, 'getExport')
      .mockImplementation((...args: Parameters<typeof realGetExport>) => {
        calls += 1
        return calls === 1 ? realGetExport(...args) : undefined
      })

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

    getExportSpy.mockRestore()

    // Succeeded (not retried, not failed) — `'abandoned'` is a normal,
    // reported outcome, the same class `courseAttachments.attach`'s own
    // `'abandoned'` status already is for the identical race on FILE-1.
    expect(result.outcome).toBe('succeeded')
    if (result.outcome === 'succeeded') {
      expect(result.job.result).toContain('abandoned')
    }

    // The part that matters: no bytes were ever written for this export,
    // even though the transcript was already read back by the time the
    // race landed.
    expect(await storage.read(organizationId, exportRow.id)).toBeUndefined()
    expect(job.id).toBeTruthy()
  })

  // Also-fix of the ADMIN-1..5 rework — a non-permanent write failure (a
  // full disk, a permissions error) used to leave this row `pending`
  // forever once `@bloombot/jobs`' own retries were exhausted: the *job*
  // row reached its own terminal `failed` state, and nothing ever told
  // this one to. `maxAttempts: 1` makes the very first attempt this job's
  // own last one, so the failure below is guaranteed to hit that branch.
  it('marks the export failed — not left pending — when writing the file fails on the job’s own last attempt', async () => {
    const storage = await setUp()
    const { organizationId, course, instructor } = seedCourseWithTranscript(
      testDb.db
    )
    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      { courseId: course.id, requestedByAccountId: instructor.id },
      testDb.db
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: TRANSCRIPT_EXPORT_JOB_KIND,
        payload: { exportId: exportRow.id },
        maxAttempts: 1,
      },
      testDb.db
    )

    const failingStorage = {
      write: () => Promise.reject(new Error('disk full')),
      read: storage.read.bind(storage),
      remove: storage.remove.bind(storage),
    }

    const handlers = new HandlerRegistry()
    handlers.register(
      TRANSCRIPT_EXPORT_JOB_KIND,
      createTranscriptExportHandler({ attachmentStorage: failingStorage })
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

    expect(result.outcome).toBe('failed')
    const failed = transcriptExports.getExport(
      organizationId,
      exportRow.id,
      testDb.db
    )
    expect(failed?.status).toBe('failed')
    expect(failed?.failureReason).toContain('disk full')
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

  // Must-fix 3 of the ADMIN-1..5 rework — PPL-5 applied per entry: an
  // unfiltered, whole-course export must not carry a student's own
  // identity and messages when that student has no verified address, even
  // though the *request* itself named no single student to gate on.
  it('omits a student’s entries from the file when they have no verified address, even in a whole-course export', async () => {
    const storage = await setUp()
    const { organizationId, course, instructor, student } =
      seedCourseWithTranscript(testDb.db)

    // `student` (from the seed helper, above) is verified — this is the one
    // expected to survive. A second, *unverified* student — plain
    // `createPerson`, no identity at all, the common Discord-only case
    // (D-35) — with their own message, so this test can tell "omitted"
    // from "the file was empty for an unrelated reason".
    const unverifiedStudent = people.createPerson(
      organizationId,
      { displayName: 'Unverified Student' },
      testDb.db
    )
    const unverifiedConversation = conversations.getOrCreateConversation(
      organizationId,
      {
        courseId: course.id,
        personId: unverifiedStudent.id,
        surface: 'discord',
      },
      testDb.db
    )
    if (!unverifiedConversation) throw new Error('setup failed: conversation')
    conversations.appendMessage(
      organizationId,
      unverifiedConversation.id,
      { direction: 'from_person', content: 'Where is the syllabus posted?' },
      testDb.db
    )

    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      { courseId: course.id, requestedByAccountId: instructor.id },
      testDb.db
    )
    jobs.enqueueJob(
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

    const bytes = await storage.read(organizationId, exportRow.id)
    if (!bytes) throw new Error('setup failed: no bytes written')
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      transcript: { personId: string; content: string }[]
      omittedForUnverifiedAddress: number
    }

    // Only the verified student's own message survives — the unverified
    // one is gone entirely, not merely redacted, so a `jq` over this file
    // has nothing naming them left to select.
    expect(parsed.transcript).toHaveLength(1)
    expect(parsed.transcript[0]?.personId).toBe(student.id)
    expect(parsed.transcript[0]?.content).toBe('When is office hours?')
    expect(parsed.omittedForUnverifiedAddress).toBe(1)
    expect(unverifiedStudent.id).toBeTruthy()
  })
})
