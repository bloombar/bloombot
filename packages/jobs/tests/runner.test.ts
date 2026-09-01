/**
 * `runNextJob` (JOB-1..3) against a real, throwaway database — every claim,
 * complete, retry and terminal-failure path this package's own module
 * comment describes, asserted against the database (JOB-2's own "assert
 * against the database, not a return value"), not only the return value.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { jobs, organizations } from '@bloombot/db'

import { HandlerRegistry } from '../src/registry.js'
import { runNextJob } from '../src/runner.js'
import type { RetryPolicy } from '../src/retry.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

const retryPolicy: RetryPolicy = {
  baseDelayMs: 1000,
  backoffFactor: 2,
}

function seedOrganization(testDatabase: TestDatabase): string {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    testDatabase.db
  )
  return organizationId
}

describe('runNextJob: nothing to do', () => {
  it('reports empty when the registry has no handlers at all', async () => {
    testDb = createTestDatabase()
    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers: new HandlerRegistry(),
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result).toEqual({ outcome: 'empty' })
  })

  it('reports empty when nothing eligible exists for a registered kind', async () => {
    testDb = createTestDatabase()
    const handlers = new HandlerRegistry()
    handlers.register('noop', async () => {})

    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result).toEqual({ outcome: 'empty' })
  })
})

describe('runNextJob: success', () => {
  it('runs the registered handler and marks the job succeeded', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'noop', payload: { hello: 'world' }, maxAttempts: 3 },
      testDb.db
    )

    const seenPayloads: unknown[] = []
    const handlers = new HandlerRegistry()
    handlers.register('noop', async (payload, context) => {
      seenPayloads.push(payload)
      expect(context.organizationId).toBe(organizationId)
      expect(context.jobId).toBe(enqueued.id)
      expect(context.attempts).toBe(1)
    })

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
    expect(seenPayloads).toEqual([{ hello: 'world' }])

    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row).toMatchObject({
      status: 'succeeded',
      claimedBy: null,
      claimExpiresAt: null,
    })
  })

  // SRV-6..8: whatever a handler resolves with is its own report — proven
  // here at the queue level (`packages/db`'s own `jobs.test.ts` proves
  // `completeJob`'s own `result` argument in isolation), so this is the one
  // place that proves the whole path — a handler's return value actually
  // reaches the row `runNextJob` completes — end to end.
  it("stores a handler's resolved value on the job row as its result", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'reporting', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register('reporting', async () => ({
      created: ['general'],
      alreadyPresent: ['admins'],
    }))

    await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(JSON.parse(row?.result ?? 'null')).toEqual({
      created: ['general'],
      alreadyPresent: ['admins'],
    })
  })
})

describe('runNextJob: JOB-2 retry with backoff, bounded attempts', () => {
  it('retries a failing job with growing delay, then stops in a terminal failed state carrying its reason — asserted against the database', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'flaky', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register('flaky', async () => {
      throw new Error('upstream timed out')
    })

    const deps = {
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    }

    // Attempt 1 fails: rescheduled, not yet terminal. The retry policy's
    // base delay is 1000ms, factor 2 — the next attempt is due at least
    // 1000ms out.
    const beforeFirstRetry = Date.now()
    const first = await runNextJob(deps)
    expect(first.outcome).toBe('retried')
    const rowAfterFirst = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(rowAfterFirst).toMatchObject({
      status: 'pending',
      claimedBy: null,
      claimExpiresAt: null,
      attempts: 1,
      lastError: 'upstream timed out',
    })
    expect(
      rowAfterFirst!.nextAttemptAt - beforeFirstRetry
    ).toBeGreaterThanOrEqual(
      999 // allow 1ms of test jitter below the exact 1000ms base delay
    )

    // Force the job due now — this test does not wait out real backoff
    // delays, it proves the *schedule*, not real wall-clock waiting.

    ;(testDb.db as any).$client
      .prepare('update jobs set next_attempt_at = ? where id = ?')
      .run(Date.now(), enqueued.id)

    // Attempt 2 fails: rescheduled again, delay doubled to 2000ms.
    const beforeSecondRetry = Date.now()
    const second = await runNextJob(deps)
    expect(second.outcome).toBe('retried')
    const rowAfterSecond = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(rowAfterSecond).toMatchObject({ status: 'pending', attempts: 2 })
    expect(
      rowAfterSecond!.nextAttemptAt - beforeSecondRetry
    ).toBeGreaterThanOrEqual(1999)

    ;(testDb.db as any).$client
      .prepare('update jobs set next_attempt_at = ? where id = ?')
      .run(Date.now(), enqueued.id)

    // Attempt 3 fails: attempts (3) now meets maxAttempts (3) — terminal.
    const third = await runNextJob(deps)
    expect(third.outcome).toBe('failed')
    const rowAfterThird = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(rowAfterThird).toMatchObject({
      status: 'failed',
      claimedBy: null,
      claimExpiresAt: null,
      attempts: 3,
      lastError: 'upstream timed out',
    })

    // JOB-2: still on the table, never deleted, never silently dropped.
    expect(rowAfterThird).not.toBeUndefined()
  })

  it('a job whose handler is missing (registry narrowed the claim, but the handler vanished) fails immediately without consuming an extra attempt cycle', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'ghost', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register('ghost', async () => {})
    // Simulate the defensive case runner.ts documents: the registry no
    // longer has this kind by the time the lookup runs.
    handlers.register('ghost', undefined as unknown as never)

    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result.outcome).toBe('failed')
    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row?.status).toBe('failed')
  })
})

describe('runNextJob: a payload that will not parse', () => {
  it('fails immediately, without ever calling the handler — retrying buys nothing against a payload that will never parse', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'noop', payload: {}, maxAttempts: 3 },
      testDb.db
    )
    // Simulates a row a direct writer corrupted — `enqueueJob` itself always
    // produces valid JSON (`JSON.stringify`), so this reaches past the repo
    // layer on purpose to exercise `runNextJob`'s own defensive parse guard.

    ;(testDb.db as any).$client
      .prepare('update jobs set payload = ? where id = ?')
      .run('{not valid json', enqueued.id)

    let handlerCalled = false
    const handlers = new HandlerRegistry()
    handlers.register('noop', async () => {
      handlerCalled = true
    })

    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result.outcome).toBe('failed')
    expect(handlerCalled).toBe(false)
    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row).toMatchObject({ status: 'failed' })
    expect(row?.lastError).toMatch(/could not parse job payload/)
  })
})

describe('runNextJob: JOB-1, organization scoping through the claim', () => {
  it("hands the handler the job's own organizationId, not a caller-guessed one", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    jobs.enqueueJob(
      organizationId,
      { kind: 'noop', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    let seenOrganizationId: string | undefined
    const handlers = new HandlerRegistry()
    handlers.register('noop', async (_payload, context) => {
      seenOrganizationId = context.organizationId
    })

    await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(seenOrganizationId).toBe(organizationId)
  })
})

/**
 * Simulates the ABA hazard `ownsRunningJob`'s `{owner, claimExpiresAt}` pair
 * exists to catch: this claim's own lease lapsed mid-run and a second
 * worker's `claimNextJob` reclaimed the exact same row under a different
 * owner — reaching past the repo layer on purpose (the same device the
 * "a payload that will not parse" tests above already use), since driving
 * this from two real `runNextJob` calls would need a real lease to actually
 * expire mid-handler.
 */
function reclaimUnderAnotherOwner(testDatabase: TestDatabase, jobId: string) {
  ;(testDatabase.db as any).$client
    .prepare(
      'update jobs set claimed_by = ?, claim_expires_at = ? where id = ?'
    )
    .run('worker-2', Date.now() + 60_000, jobId)
}

describe('runNextJob: rework finding 3 — a superseded claim is reported, not silently folded into another outcome', () => {
  it('reports "superseded" rather than "succeeded" when another worker reclaimed the row before completeJob could write', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'noop', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register('noop', async () => {
      reclaimUnderAnotherOwner(testDb, enqueued.id)
    })

    const logger = createFakeLogger()
    const result = await runNextJob({
      db: testDb.db,
      logger,
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    // Before this fix, `completeJob` returning `undefined` fell back to
    // `?? job` and this reported 'succeeded' — silently, with no log line —
    // even though nothing was actually written under this claim.
    expect(result.outcome).toBe('superseded')
    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row).toMatchObject({ status: 'running', claimedBy: 'worker-2' })
    expect(logger.warnCalls.length).toBeGreaterThan(0)
  })

  it('reports "superseded" rather than "failed" for a terminal failure whose claim was reclaimed first', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'flaky', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register('flaky', async () => {
      reclaimUnderAnotherOwner(testDb, enqueued.id)
      throw new Error('boom')
    })

    const logger = createFakeLogger()
    const result = await runNextJob({
      db: testDb.db,
      logger,
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result.outcome).toBe('superseded')
    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row).toMatchObject({ status: 'running', claimedBy: 'worker-2' })
    expect(logger.warnCalls.length).toBeGreaterThan(0)
  })

  it('reports "superseded" rather than "retried" for a retryable failure whose claim was reclaimed first', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'flaky', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register('flaky', async () => {
      reclaimUnderAnotherOwner(testDb, enqueued.id)
      throw new Error('boom')
    })

    const logger = createFakeLogger()
    const result = await runNextJob({
      db: testDb.db,
      logger,
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result.outcome).toBe('superseded')
    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row).toMatchObject({ status: 'running', claimedBy: 'worker-2' })
    expect(logger.warnCalls.length).toBeGreaterThan(0)
  })
})

describe('runNextJob: rework finding 7 — a non-Error throw keeps something useful in the row', () => {
  it('records a JSON-stringified reason rather than "[object Object]" for a thrown plain object', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'flaky', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    handlers.register('flaky', async () => {
      throw { code: 42 }
    })

    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 60_000,
      retryPolicy,
    })

    expect(result.outcome).toBe('failed')
    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row?.lastError).not.toMatch(/object Object/)
    expect(row?.lastError).toBe('{"code":42}')
  })
})

describe('runNextJob: rework finding 5 — a wedged handler is bounded by a timeout', () => {
  it('fails the attempt with a clear reason once handlerTimeoutMs elapses, rather than awaiting a handler that never settles', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb)
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'wedged', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    const handlers = new HandlerRegistry()
    // A handler whose own promise never resolves or rejects — the case
    // finding 5 targets: no timeout, and this call would await it forever.
    handlers.register('wedged', () => new Promise<void>(() => {}))

    const result = await runNextJob({
      db: testDb.db,
      logger: createFakeLogger(),
      handlers,
      owner: 'worker-1',
      leaseMs: 60_000,
      handlerTimeoutMs: 20,
      retryPolicy,
    })

    expect(result.outcome).toBe('failed')
    const row = jobs.getJob(organizationId, enqueued.id, testDb.db)
    expect(row?.lastError).toMatch(/did not settle within 20ms/)
  })
})
