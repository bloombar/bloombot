/**
 * `contentDeletions.removeBytes` (PROJ-8/PROJ-9) — against a real,
 * throwaway database, a throwaway `AttachmentStorage` directory, and a
 * loopback fake standing in for OpenAI's Files/Vector Stores endpoints
 * (`FakeOpenAiFilesServer`, the same fake `course-attachments.test.ts` uses
 * for `courseAttachments.detach`). Fails without this slice's code: before
 * it, `apps/worker` registered no `contentDeletions.removeBytes` job kind
 * at all, and nothing removed a deleted course's or project's own
 * attachment bytes — locally, or at the provider — from disk.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  createFilesystemAttachmentStorage,
  jobs,
  organizations,
} from '@bloombot/db'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import type { FilesHttpOptions } from '@bloombot/openai'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createRemoveDeletedContentBytesHandler,
  REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
} from '../../src/handlers/content-deletions.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { FakeOpenAiFilesServer } from '../helpers/fake-openai-files-server.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

const STORAGE_ROOT = join(
  process.cwd(),
  'tmp',
  'worker-tests',
  'content-deletions'
)

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

describe('contentDeletions.removeBytes handler', () => {
  it('removes every attachment’s and export’s own bytes named in the payload', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Test Org', isPersonal: false },
      testDb.db
    )
    await storage.write(organizationId, 'attachment-1', Buffer.from('x'))
    await storage.write(organizationId, 'export-1', Buffer.from('y'))

    const handlers = new HandlerRegistry()
    handlers.register(
      REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      createRemoveDeletedContentBytesHandler({
        attachmentStorage: storage,
        openaiHttpOptions,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          courses: [
            {
              courseId: 'course-1',
              vectorStoreId: null,
              attachments: [
                { attachmentId: 'attachment-1', providerFileId: null },
              ],
              exportIds: ['export-1'],
            },
          ],
        },
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
    expect(await storage.read(organizationId, 'attachment-1')).toBeUndefined()
    expect(await storage.read(organizationId, 'export-1')).toBeUndefined()
  })

  // DATA-8 rework, must-fix 1 — `handlers/retention-sweep.ts` enqueues this
  // job under a *different* organization than the one whose bytes it is
  // removing (the real one has already been permanently deleted, so it is
  // no longer a valid `jobs.organizationId` — `ParsedPayload`'s own doc
  // comment has the full mechanism). Fails without this slice's code:
  // before it, this handler always used `context.organizationId` — the job
  // row's own organization — to find the bytes, so it would have looked in
  // `jobOwnerOrganizationId`'s own (empty) directory and reported the
  // attachment already gone, leaving it on disk under `bytesOrganizationId`
  // forever.
  it('removes bytes from the organization the payload names, not the job row’s own organization, when the two differ', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const jobOwnerOrganizationId = randomUUID()
    const bytesOrganizationId = randomUUID()
    organizations.createOrganization(
      jobOwnerOrganizationId,
      { name: 'Job Owner Org', isPersonal: false },
      testDb.db
    )
    organizations.createOrganization(
      bytesOrganizationId,
      { name: 'Bytes Org', isPersonal: false },
      testDb.db
    )
    await storage.write(bytesOrganizationId, 'attachment-1', Buffer.from('x'))

    const handlers = new HandlerRegistry()
    handlers.register(
      REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      createRemoveDeletedContentBytesHandler({
        attachmentStorage: storage,
        openaiHttpOptions,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      jobOwnerOrganizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          organizationId: bytesOrganizationId,
          courses: [
            {
              courseId: 'course-1',
              vectorStoreId: null,
              attachments: [
                { attachmentId: 'attachment-1', providerFileId: null },
              ],
              exportIds: [],
            },
          ],
        },
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
    expect(
      await storage.read(bytesOrganizationId, 'attachment-1')
    ).toBeUndefined()
  })

  it('is a no-op, not an error, for an id that was never written (already removed, or a foreign id)', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Test Org', isPersonal: false },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register(
      REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      createRemoveDeletedContentBytesHandler({
        attachmentStorage: storage,
        openaiHttpOptions,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          courses: [
            {
              courseId: 'course-1',
              vectorStoreId: null,
              attachments: [
                { attachmentId: 'never-written', providerFileId: null },
              ],
              exportIds: [],
            },
          ],
        },
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
  })

  // Must-fix 3 (rework round 1): an attachment that ever recorded a
  // `providerFileId` (FILE-1) must have its provider-side resources removed
  // too — the vector-store entry, then the file object itself, the same
  // two calls, in the same order, `courseAttachments.detach`'s own handler
  // makes.
  it('reaches the provider for every attachment that recorded a providerFileId, then removes its bytes', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Test Org', isPersonal: false },
      testDb.db
    )
    await storage.write(organizationId, 'attachment-1', Buffer.from('x'))

    const handlers = new HandlerRegistry()
    handlers.register(
      REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      createRemoveDeletedContentBytesHandler({
        attachmentStorage: storage,
        openaiHttpOptions,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          courses: [
            {
              courseId: 'course-1',
              vectorStoreId: 'vs_1',
              attachments: [
                { attachmentId: 'attachment-1', providerFileId: 'file_1' },
              ],
              exportIds: [],
            },
          ],
        },
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
    // Both provider deletes for the attachment — the vector-store entry,
    // then the file object — and, cheap-fix 2, the store itself.
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
    expect(
      openaiServer.requests.some(
        (r) => r.method === 'DELETE' && r.path === '/vector_stores/vs_1'
      )
    ).toBe(true)
    expect(await storage.read(organizationId, 'attachment-1')).toBeUndefined()
  })

  // Must-fix 3's own idempotence requirement: a 404 from either provider
  // delete means "already gone" (an earlier attempt, or a retry after a
  // partial success), not a failure — the same rework finding
  // `course-attachments.test.ts` pins for `courseAttachments.detach`.
  it('a 404 from a provider delete is treated as already gone, and the local removal still completes', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Test Org', isPersonal: false },
      testDb.db
    )
    await storage.write(organizationId, 'attachment-1', Buffer.from('x'))
    openaiServer.respondToVectorStoreFileDelete({
      status: 404,
      body: { error: { message: 'no longer there' } },
    })
    openaiServer.respondToFileDelete({
      status: 404,
      body: { error: { message: 'no longer there' } },
    })
    openaiServer.respondToVectorStoreDelete({
      status: 404,
      body: { error: { message: 'no longer there' } },
    })

    const handlers = new HandlerRegistry()
    handlers.register(
      REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      createRemoveDeletedContentBytesHandler({
        attachmentStorage: storage,
        openaiHttpOptions,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          courses: [
            {
              courseId: 'course-1',
              vectorStoreId: 'vs_1',
              attachments: [
                { attachmentId: 'attachment-1', providerFileId: 'file_1' },
              ],
              exportIds: [],
            },
          ],
        },
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
    expect(await storage.read(organizationId, 'attachment-1')).toBeUndefined()
  })

  // Must-fix 1 (rework round 2): a non-404 provider failure must not be
  // logged and shrugged off while the local bytes are removed anyway — that
  // combination is exactly what orphans a file at the provider forever,
  // since nothing local is left afterward to even name it for a later
  // sweep. This attempt must fail (so `@bloombot/jobs`' own retry policy
  // actually retries it), and this attachment's own bytes must survive it.
  it('a non-404 provider failure fails the job attempt and keeps the attachment’s local bytes', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Test Org', isPersonal: false },
      testDb.db
    )
    await storage.write(organizationId, 'attachment-1', Buffer.from('x'))
    openaiServer.respondToFileDelete({
      status: 500,
      body: { error: { message: 'upstream is having a bad day' } },
    })

    const handlers = new HandlerRegistry()
    handlers.register(
      REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      createRemoveDeletedContentBytesHandler({
        attachmentStorage: storage,
        openaiHttpOptions,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          courses: [
            {
              courseId: 'course-1',
              vectorStoreId: null,
              attachments: [
                { attachmentId: 'attachment-1', providerFileId: 'file_1' },
              ],
              exportIds: [],
            },
          ],
        },
        maxAttempts: 3,
      },
      testDb.db
    )

    const firstAttempt = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      // No real backoff wait — this test proves the retry actually
      // happens and what it does, not the schedule
      // (`packages/jobs/tests/runner.test.ts` proves that).
      retryPolicy: { baseDelayMs: 0, backoffFactor: 1 },
    })

    expect(firstAttempt.outcome).toBe('retried')
    // Never removed — the provider still holds a copy this attempt could
    // not undo.
    expect(await storage.read(organizationId, 'attachment-1')).toBeDefined()

    // A later attempt, once the provider actually cooperates (200, or 404
    // for "already gone" — either means nothing is left to undo there),
    // succeeds and removes the bytes this time.
    const secondAttempt = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy: { baseDelayMs: 0, backoffFactor: 1 },
    })

    expect(secondAttempt.outcome).toBe('succeeded')
    expect(await storage.read(organizationId, 'attachment-1')).toBeUndefined()
  })

  // Cheap-fix 2's own must-fix 1 rule, applied to the store itself: a
  // failure deleting the vector store must fail the job the identical way
  // a failure deleting an attachment's own file does.
  it('a non-404 failure deleting the vector store itself fails the job attempt', async () => {
    const { storage, openaiHttpOptions } = await setUp()
    const organizationId = randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Test Org', isPersonal: false },
      testDb.db
    )
    openaiServer.respondToVectorStoreDelete({
      status: 500,
      body: { error: { message: 'upstream is having a bad day' } },
    })

    const handlers = new HandlerRegistry()
    handlers.register(
      REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      createRemoveDeletedContentBytesHandler({
        attachmentStorage: storage,
        openaiHttpOptions,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          courses: [
            {
              courseId: 'course-1',
              vectorStoreId: 'vs_1',
              attachments: [],
              exportIds: [],
            },
          ],
        },
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

    expect(result.outcome).toBe('retried')
  })
})
