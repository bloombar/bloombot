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
    // Both provider deletes — the vector-store entry, then the file object.
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
})
