/**
 * Repository for `jobs` (JOB-1..3) — the background queue's data layer.
 * Every atomicity claim here is checked against the real, throwaway
 * database `createTestDatabase` opens under `tmp/`, never a return value
 * alone.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  closeDatabase,
  courses,
  jobs,
  openDatabase,
  organizations,
  projects,
  type Database,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one enabled course — enough to prove JOB-1's cross-tenant payload claim. */
function seedTwoOrganizationsWithCourses(testDatabase: TestDatabase) {
  const orgA = randomUUID()
  const orgB = randomUUID()
  organizations.createOrganization(
    orgA,
    { name: 'Org A', isPersonal: false },
    testDatabase.db
  )
  organizations.createOrganization(
    orgB,
    { name: 'Org B', isPersonal: false },
    testDatabase.db
  )
  const projectA = projects.createProject(
    orgA,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const projectB = projects.createProject(
    orgB,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const courseA = courses.createCourse(
    orgA,
    {
      projectId: projectA.id,
      title: 'Course A',
      filePrefix: 'ca',
      enabled: true,
      adminsRole: 'admins-ca',
      studentsRole: 'students-ca',
      categories: [],
    },
    testDatabase.db
  )
  const courseB = courses.createCourse(
    orgB,
    {
      projectId: projectB.id,
      title: 'Course B',
      filePrefix: 'cb',
      enabled: true,
      adminsRole: 'admins-cb',
      studentsRole: 'students-cb',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseA.ok || !courseB.ok) {
    throw new Error('expected both seeded courses to save cleanly')
  }
  return { orgA, orgB, courseA: courseA.course, courseB: courseB.course }
}

describe('enqueueJob (JOB-1)', () => {
  it('creates a pending, unclaimed job carrying the organization it belongs to', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)

    const job = jobs.enqueueJob(
      orgA,
      { kind: 'noop', payload: { hello: 'world' }, maxAttempts: 5 },
      testDb.db
    )

    expect(job.organizationId).toBe(orgA)
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(0)
    expect(job.maxAttempts).toBe(5)
    expect(job.claimedBy).toBeNull()
    expect(job.claimExpiresAt).toBeNull()
    expect(JSON.parse(job.payload)).toEqual({ hello: 'world' })
  })

  // JOB-1's own worked example: a job carries its organization, and a
  // handler cannot reach another organization's data through the payload —
  // a payload naming another tenant's record is refused by the repo layer
  // as usual, the same as every other scoped read.
  it("a payload naming another organization's record is refused the same way any other cross-tenant read is", () => {
    testDb = createTestDatabase()
    const { orgA, courseB } = seedTwoOrganizationsWithCourses(testDb)

    // Org A's job, whose payload names Org B's own course — this is
    // ordinary caller error (a bug, or an attempt to reach across tenants),
    // not something enqueueJob can see, since a payload is opaque to it
    // (JOB-1).
    const job = jobs.enqueueJob(
      orgA,
      { kind: 'noop', payload: { courseId: courseB.id }, maxAttempts: 5 },
      testDb.db
    )
    const payload = JSON.parse(job.payload) as { courseId: string }

    // The handler this job would run reads its own organization off the
    // claimed row (JOB-1's discipline: never trust an id inside a payload
    // alone) and reaches the payload's courseId through the same
    // organization-scoped function every other caller uses.
    const resolved = courses.getCourse(
      job.organizationId,
      payload.courseId,
      testDb.db
    )

    expect(resolved).toBeUndefined()
  })
})

describe('claimNextJob (JOB-3): the race', () => {
  it('two connections claiming the same eligible job concurrently yield exactly one winner, and the loser gets nothing rather than an error', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    jobs.enqueueJob(
      orgA,
      { kind: 'send-welcome-email', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    // A second real connection to the same file — better-sqlite3's own
    // calls are synchronous, so nothing can interleave *within* either
    // connection's own claim below; both run to completion against the
    // real database, through the real exported function, one after the
    // other. The genuinely concurrent case — a second connection whose own
    // read happened before the first connection's write committed — is
    // covered by the lease test below and by `discord-servers.test.ts`'s
    // own `stubSecondReadAsStale` device for the same class of race; this
    // test proves the more basic invariant a stub cannot: calling the real
    // claim twice for the one eligible row never grants it twice, and the
    // loser gets `undefined`, not a thrown error.
    const db2 = openDatabase(testDb.path)
    try {
      const winner = jobs.claimNextJob(
        ['send-welcome-email'],
        { owner: 'worker-1', leaseMs: 60_000 },
        testDb.db
      )
      const loser = jobs.claimNextJob(
        ['send-welcome-email'],
        { owner: 'worker-2', leaseMs: 60_000 },
        db2
      )

      expect(winner).toMatchObject({ status: 'running', claimedBy: 'worker-1' })
      expect(loser).toBeUndefined()
    } finally {
      closeDatabase(db2)
    }
  })

  // The genuinely concurrent case: connection 2's own read happened before
  // connection 1's write committed, so it still believes the job is
  // pending. Reproduced the same way `discord-servers.test.ts` reproduces
  // it for TEN-3 — better-sqlite3 is synchronous, so nothing else can run
  // between one connection's own read and its own write; stubbing the
  // second connection's read is how a single-threaded test reaches the
  // exact window a genuinely concurrent worker can land in.
  it("a claim whose own read is stale loses the race — the write's own WHERE decides it, not the read", async () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    const seeded = jobs.enqueueJob(
      orgA,
      { kind: 'send-welcome-email', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const db2 = openDatabase(testDb.path)
    try {
      // Connection 2's own `select` is stubbed to still see the job as
      // pending — as it would have, had it looked before connection 1's
      // claim below committed.
      const { vi } = await import('vitest')
      const realSelect = db2.select.bind(db2)
      let selectCallCount = 0
      vi.spyOn(db2, 'select').mockImplementation((...args: unknown[]) => {
        selectCallCount += 1
        if (selectCallCount === 1) {
          return {
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: () => ({ get: () => ({ id: seeded.id }) }),
                }),
              }),
            }),
          } as never
        }
        return (realSelect as (...a: unknown[]) => unknown)(...args) as never
      })

      const winner = jobs.claimNextJob(
        ['send-welcome-email'],
        { owner: 'worker-1', leaseMs: 60_000 },
        testDb.db
      )
      expect(winner).toMatchObject({ status: 'running', claimedBy: 'worker-1' })

      // Connection 2 attempts the real UPDATE for the same candidate id it
      // believes is still pending; the row is genuinely already running
      // under worker-1's claim by now, so the UPDATE's own WHERE refuses it.
      const loser = jobs.claimNextJob(
        ['send-welcome-email'],
        { owner: 'worker-2', leaseMs: 60_000 },
        db2
      )
      expect(loser).toBeUndefined()

      // Untouched: still worker-1's claim.
      const row = jobs.getJob(orgA, seeded.id, testDb.db)
      expect(row?.claimedBy).toBe('worker-1')
    } finally {
      closeDatabase(db2)
    }
  })
})

describe('claimNextJob (JOB-3): the lease', () => {
  it('a job whose claim has expired is re-claimable', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    const seeded = jobs.enqueueJob(
      orgA,
      { kind: 'send-welcome-email', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    // A 0ms lease is already expired by the time the next claim runs.
    const first = jobs.claimNextJob(
      ['send-welcome-email'],
      { owner: 'worker-1', leaseMs: -5 },
      testDb.db
    )
    expect(first).toMatchObject({ status: 'running', claimedBy: 'worker-1' })

    const second = jobs.claimNextJob(
      ['send-welcome-email'],
      { owner: 'worker-2', leaseMs: 60_000 },
      testDb.db
    )

    expect(second).toMatchObject({
      id: seeded.id,
      status: 'running',
      claimedBy: 'worker-2',
    })
  })

  it('a job whose claim is still live is not re-claimable', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    jobs.enqueueJob(
      orgA,
      { kind: 'send-welcome-email', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const first = jobs.claimNextJob(
      ['send-welcome-email'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )
    expect(first).toMatchObject({ status: 'running', claimedBy: 'worker-1' })

    const second = jobs.claimNextJob(
      ['send-welcome-email'],
      { owner: 'worker-2', leaseMs: 60_000 },
      testDb.db
    )

    expect(second).toBeUndefined()
  })

  it('never claims a job whose kind the caller has no handler for', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    jobs.enqueueJob(
      orgA,
      { kind: 'send-welcome-email', payload: {}, maxAttempts: 3 },
      testDb.db
    )

    const claimed = jobs.claimNextJob(
      ['import-roster'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )

    expect(claimed).toBeUndefined()
  })
})

describe('completing and failing a claimed job', () => {
  it('completeJob marks a claimed job succeeded and releases the claim', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    jobs.enqueueJob(
      orgA,
      { kind: 'noop', payload: {}, maxAttempts: 3 },
      testDb.db
    )
    const claimed = jobs.claimNextJob(
      ['noop'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )
    if (!claimed) throw new Error('expected a claim')

    const completed = jobs.completeJob(
      orgA,
      claimed.id,
      { owner: 'worker-1', claimExpiresAt: claimed.claimExpiresAt! },
      testDb.db
    )

    expect(completed).toMatchObject({
      status: 'succeeded',
      claimedBy: null,
      claimExpiresAt: null,
    })
  })

  // The exact hazard `OwnedClaim` exists to close: a claim that has since
  // been superseded (its lease expired and someone else reclaimed the row)
  // must not be able to complete or fail the *new* claim out from under it.
  it('completeJob refuses a claim that has since been superseded by a reclaim', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    jobs.enqueueJob(
      orgA,
      { kind: 'noop', payload: {}, maxAttempts: 3 },
      testDb.db
    )
    const firstClaim = jobs.claimNextJob(
      ['noop'],
      { owner: 'worker-1', leaseMs: -5 }, // already-expired lease
      testDb.db
    )
    if (!firstClaim) throw new Error('expected a claim')

    // worker-2 reclaims the same row once worker-1's lease has lapsed.
    const secondClaim = jobs.claimNextJob(
      ['noop'],
      { owner: 'worker-2', leaseMs: 60_000 },
      testDb.db
    )
    if (!secondClaim) throw new Error('expected a reclaim')

    // worker-1's own, now-stale claim tries to complete the job it no
    // longer owns.
    const result = jobs.completeJob(
      orgA,
      firstClaim.id,
      { owner: 'worker-1', claimExpiresAt: firstClaim.claimExpiresAt! },
      testDb.db
    )

    expect(result).toBeUndefined()
    // Untouched: still running under worker-2's claim.
    const row = jobs.getJob(orgA, firstClaim.id, testDb.db)
    expect(row).toMatchObject({ status: 'running', claimedBy: 'worker-2' })
  })

  // JOB-2: retried with growing delay, stops after its bound, and its
  // terminal row still carries the reason it stopped — asserted against the
  // database, not a return value.
  it('rescheduleJobForRetry returns a job to pending, due later, with the failure reason recorded', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    jobs.enqueueJob(
      orgA,
      { kind: 'flaky', payload: {}, maxAttempts: 3 },
      testDb.db
    )
    const claimed = jobs.claimNextJob(
      ['flaky'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )
    if (!claimed) throw new Error('expected a claim')

    const nextAttemptAt = Date.now() + 1000
    jobs.rescheduleJobForRetry(
      orgA,
      claimed.id,
      { owner: 'worker-1', claimExpiresAt: claimed.claimExpiresAt! },
      { reason: 'upstream timed out', nextAttemptAt },
      testDb.db
    )

    const row = jobs.getJob(orgA, claimed.id, testDb.db)
    expect(row).toMatchObject({
      status: 'pending',
      claimedBy: null,
      claimExpiresAt: null,
      lastError: 'upstream timed out',
      nextAttemptAt,
    })
  })

  it('markJobFailed stops a job in a terminal, visible failed state carrying its reason', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    jobs.enqueueJob(
      orgA,
      { kind: 'flaky', payload: {}, maxAttempts: 1 },
      testDb.db
    )
    const claimed = jobs.claimNextJob(
      ['flaky'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )
    if (!claimed) throw new Error('expected a claim')

    jobs.markJobFailed(
      orgA,
      claimed.id,
      { owner: 'worker-1', claimExpiresAt: claimed.claimExpiresAt! },
      'exhausted attempts: upstream timed out',
      testDb.db
    )

    // Still on the table, never deleted, never silently dropped (JOB-2).
    const row = jobs.getJob(orgA, claimed.id, testDb.db)
    expect(row).toMatchObject({
      status: 'failed',
      claimedBy: null,
      claimExpiresAt: null,
      lastError: 'exhausted attempts: upstream timed out',
    })
  })
})

describe('getJob and countQueuedJobs', () => {
  it('getJob refuses a job belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizationsWithCourses(testDb)
    const job = jobs.enqueueJob(
      orgA,
      { kind: 'noop', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    expect(jobs.getJob(orgB, job.id, testDb.db)).toBeUndefined()
  })

  it('countQueuedJobs counts pending and running jobs across every organization, not succeeded or failed ones', () => {
    testDb = createTestDatabase()
    const { orgA, orgB } = seedTwoOrganizationsWithCourses(testDb)

    jobs.enqueueJob(orgA, { kind: 'a', payload: {}, maxAttempts: 1 }, testDb.db)
    jobs.enqueueJob(orgB, { kind: 'b', payload: {}, maxAttempts: 1 }, testDb.db)
    const claimed = jobs.claimNextJob(
      ['a'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )
    if (!claimed) throw new Error('expected a claim')
    jobs.completeJob(
      orgA,
      claimed.id,
      { owner: 'worker-1', claimExpiresAt: claimed.claimExpiresAt! },
      testDb.db
    )

    // One completed (excluded) and one still pending (included).
    expect(jobs.countQueuedJobs(testDb.db)).toBe(1)
  })
})

// Confirms this file's own type import compiles and is exercised — a plain
// smoke test so `Database` staying imported for typing below is not flagged
// as unused if every other test above only ever passes `testDb.db` through.
describe('type sanity', () => {
  it('Job/Database types line up with the schema this file exercises', () => {
    testDb = createTestDatabase()
    const db: Database = testDb.db
    const { orgA } = seedTwoOrganizationsWithCourses(testDb)
    const job = jobs.enqueueJob(
      orgA,
      { kind: 'noop', payload: {}, maxAttempts: 1 },
      db
    )
    expect(job.kind).toBe('noop')
  })
})
