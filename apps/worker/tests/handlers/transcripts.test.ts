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
  type AttachmentStorage,
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
  // reuses this helper and names this student by `personId` (a
  // student-filtered export, still gated on `hasVerifiedAddress`,
  // `apps/worker/src/handlers/transcripts.ts`) gets a verified student for
  // free; the *unverified* case has its own dedicated test and seeds its
  // own person, below.
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
  //
  // This proves the *code path* — the re-check itself, and that nothing
  // is written once it fails — not the outcome an operator actually sees
  // for a real deletion: `deleteOrganizationData` removes the `jobs` row
  // in the same transaction as `transcript_exports`, so `@bloombot/jobs`'
  // own `completeJob` finds no row to mark either, and the real result is
  // `'superseded'` (logged as "this claim was superseded... the job may
  // run twice," which is misleading about the actual cause here), with
  // this handler's own `'abandoned'` report discarded rather than ever
  // reaching a job row to read back. The test just below this one — which
  // deletes the tenant for real, mid-write, rather than spying on one
  // function's return value — is the one that proves what an operator
  // actually sees.
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

  // Must-fix 3 of the ADMIN-1..5 rework's third round — the residual
  // window the re-check alone cannot close: the tenant is deleted for
  // real, through the same `deleteOrganizationData` `routes/admin.ts`
  // itself calls, *while* `attachmentStorage.write` is still running —
  // simulated here by making the fake storage's own `write` perform the
  // real write and then, as its own side effect before resolving, run the
  // real deletion, rather than mocking `markExportReady`'s own return
  // value directly: everything downstream (the row actually being gone,
  // `markExportReady` actually returning `undefined` because of it,
  // `@bloombot/jobs`' own real handling of a job whose row also vanished)
  // is real, not asserted by construction.
  it('deletes the bytes it just wrote, deterministically, when the tenant is deleted for real while the write is still in flight', async () => {
    const realStorage = await setUp()
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
        maxAttempts: 3,
      },
      testDb.db
    )

    const deletingStorage: AttachmentStorage = {
      write: async (org, id, bytes) => {
        await realStorage.write(org, id, bytes)
        // The deletion "lands" here — after the bytes are genuinely on
        // disk, before this handler's own `write` call even returns.
        organizations.deleteOrganizationData(organizationId, testDb.db)
      },
      read: (org, id) => realStorage.read(org, id),
      remove: (org, id) => realStorage.remove(org, id),
    }

    const handlers = new HandlerRegistry()
    handlers.register(
      TRANSCRIPT_EXPORT_JOB_KIND,
      createTranscriptExportHandler({ attachmentStorage: deletingStorage })
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

    // The job row is gone too (`deleteOrganizationData` removes `jobs`
    // rows in the same transaction) — `@bloombot/jobs`' own real outcome
    // for a claim that no longer has a row to record against, not a
    // status this test invents.
    expect(result.outcome).toBe('superseded')

    // The part that matters: the bytes this handler just wrote to a now-
    // deleted tenant's own directory are gone, because this handler
    // removed them itself — not left for a cross-process timer that a
    // deploy landing in the next five seconds would have discarded.
    expect(await realStorage.read(organizationId, exportRow.id)).toBeUndefined()
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

  // Must-fix 1 of the ADMIN-1..5 rework's third round — the reviewer's own
  // call, reversing an earlier draft that filtered *entries* by
  // `hasVerifiedAddress` and silently emptied this exact case (an
  // ordinary, Discord-only course, where `hasVerifiedAddress` is false for
  // everyone): an unfiltered course export must still carry every
  // student's own messages, with nothing left to attribute a line to a
  // named person.
  it('carries every message in an unfiltered export, but strips personId and personDisplayName from all of them', async () => {
    const storage = await setUp()
    const { organizationId, course, instructor } = seedCourseWithTranscript(
      testDb.db
    )

    // A second student, deliberately *unverified* — plain `createPerson`,
    // no identity at all, the common Discord-only case (D-35) — with their
    // own message, so this test proves content survives regardless of
    // verification, which is the entire point of this rework.
    const secondStudent = people.createPerson(
      organizationId,
      { displayName: 'Second Student' },
      testDb.db
    )
    const secondConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: secondStudent.id, surface: 'discord' },
      testDb.db
    )
    if (!secondConversation) throw new Error('setup failed: conversation')
    conversations.appendMessage(
      organizationId,
      secondConversation.id,
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
      deidentified: boolean
      transcript: Record<string, unknown>[]
    }

    // Both messages survive — the ordinary case must not come back empty.
    expect(parsed.deidentified).toBe(true)
    expect(parsed.transcript).toHaveLength(2)
    const contents = parsed.transcript.map((entry) => entry['content']).sort()
    expect(contents).toEqual(
      ['When is office hours?', 'Where is the syllabus posted?'].sort()
    )
    // Nothing in *any* entry names who sent it — a `jq
    // 'select(.personId=="…")'` over this file has no field to select on,
    // for the verified student or the unverified one alike.
    for (const entry of parsed.transcript) {
      expect(entry).not.toHaveProperty('personId')
      expect(entry).not.toHaveProperty('personDisplayName')
    }
    expect(secondStudent.id).toBeTruthy()
  })

  // The other half of the same trade: a *student-filtered* export still
  // names exactly the one student it was asked for — that disclosure is
  // the export's whole point, and `transcripts.export`'s own action has
  // already refused this request outright unless that student's own
  // address is verified (`packages/actions/tests/transcripts.test.ts`'s
  // own PPL-5 coverage), so this handler owes no further gate here.
  it('carries the named student’s own identity in a student-filtered export', async () => {
    const storage = await setUp()
    const { organizationId, course, instructor, student } =
      seedCourseWithTranscript(testDb.db)

    const exportRow = transcriptExports.createPendingExport(
      organizationId,
      {
        courseId: course.id,
        personId: student.id,
        requestedByAccountId: instructor.id,
      },
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
      deidentified: boolean
      transcript: { personId: string; content: string }[]
    }

    expect(parsed.deidentified).toBe(false)
    expect(parsed.transcript).toHaveLength(1)
    expect(parsed.transcript[0]?.personId).toBe(student.id)
    expect(parsed.transcript[0]?.content).toBe('When is office hours?')
  })
})
