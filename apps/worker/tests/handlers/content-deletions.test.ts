/**
 * `contentDeletions.removeBytes` (PROJ-8/PROJ-9) — against a real,
 * throwaway database and a throwaway `AttachmentStorage` directory. Fails
 * without this slice's code: before it, `apps/worker` registered no
 * `contentDeletions.removeBytes` job kind at all, and nothing removed a
 * deleted course's or project's own attachment bytes from disk.
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
import { afterEach, describe, expect, it } from 'vitest'

import {
  createRemoveDeletedContentBytesHandler,
  REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
} from '../../src/handlers/content-deletions.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

const STORAGE_ROOT = join(
  process.cwd(),
  'tmp',
  'worker-tests',
  'content-deletions'
)

let testDb: TestDatabase
let storageDir: string

afterEach(() => {
  testDb.cleanup()
  rmSync(storageDir, { recursive: true, force: true })
})

const retryPolicy: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

function setUp() {
  testDb = createTestDatabase()
  storageDir = join(STORAGE_ROOT, randomUUID())
  mkdirSync(storageDir, { recursive: true })
  return createFilesystemAttachmentStorage(storageDir)
}

describe('contentDeletions.removeBytes handler', () => {
  it('removes every attachment and export id named in the payload', async () => {
    const storage = setUp()
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
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: {
          attachmentIds: ['attachment-1'],
          exportIds: ['export-1'],
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
    const storage = setUp()
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
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      organizationId,
      {
        kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
        payload: { attachmentIds: ['never-written'], exportIds: [] },
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
})
