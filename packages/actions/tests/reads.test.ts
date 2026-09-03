/**
 * PROJ-5: the control panel reads through the same action layer it writes
 * through. Every read action this slice adds — `projects.list`,
 * `courses.list`, `courses.get`, `discordServers.list` — is exercised
 * through `dispatch` the same way the writes in `actions.test.ts` are, and
 * proven tenant-scoped the same way: a caller cannot see, or name, another
 * organization's record through any of them. `jobs.get` (SRV-6..8) joins
 * them this slice — the read that makes the queue usable rather than a hole
 * work disappears into.
 */

import { courses, discordServers, jobs, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  getCourseAction,
  getJobAction,
  listCoursesAction,
  listDiscordServersAction,
  listJobsAction,
  listProjectsAction,
} from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { ActionInputError, ActionRefusedError } from '../src/errors.js'
import {
  seedOrganizationWithBoundServer,
  seedOrganizationWithProject,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('projects.list', () => {
  it("lists the caller's own organization's active projects, excluding archived ones by default", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    const archived = projects.createProject(
      organizationId,
      { name: 'Spring 2026' },
      testDb.db
    )
    projects.archiveProject(organizationId, archived.id, testDb.db)

    const result = await dispatch(
      listProjectsAction,
      {},
      { organizationId, db: testDb.db }
    )

    expect(result.map((p) => p.id)).toEqual([projectId])
  })

  it('includes archived projects when asked', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    const archived = projects.createProject(
      organizationId,
      { name: 'Spring 2026' },
      testDb.db
    )
    projects.archiveProject(organizationId, archived.id, testDb.db)

    const result = await dispatch(
      listProjectsAction,
      { includeArchived: true },
      { organizationId, db: testDb.db }
    )

    expect(result.map((p) => p.id).sort()).toEqual(
      [
        ...projects
          .listProjects(organizationId, testDb.db, { includeArchived: false })
          .map((p) => p.id),
        archived.id,
      ].sort()
    )
  })

  it("does not include another organization's projects", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(
      testDb.db,
      'Org A Term'
    )
    seedOrganizationWithProject(testDb.db, 'Org B Term')

    const result = await dispatch(
      listProjectsAction,
      {},
      { organizationId: orgA, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('Org A Term')
  })
})

describe('courses.list', () => {
  it("lists a project's own courses", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      listCoursesAction,
      { projectId },
      { organizationId, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: created.course.id,
      title: 'Web Design',
    })
  })

  it("refuses another organization's project, the same way a write does", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { projectId: projectBId } = seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        listCoursesAction,
        { projectId: projectBId },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('courses.get', () => {
  it('opens one course, with its categories and channels', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [
          {
            name: 'GLOBAL',
            channels: [{ name: 'chat', adminsOnly: false }],
          },
        ],
      },
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      getCourseAction,
      { courseId: created.course.id },
      { organizationId, db: testDb.db }
    )

    expect(result.title).toBe('Web Design')
    expect(result.categories).toHaveLength(1)
    expect(result.categories[0]?.channels).toHaveLength(1)
    expect(result.categories[0]?.channels[0]?.name).toBe('chat')
  })

  it("refuses another organization's course, the same way a write does", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)
    const courseB = courses.createCourse(
      orgB,
      {
        projectId: projectBId,
        title: 'Org B Course',
        filePrefix: 'ob',
        enabled: true,
        adminsRole: 'admins-ob',
        studentsRole: 'students-ob',
        categories: [],
      },
      testDb.db
    )
    if (!courseB.ok) throw new Error('setup failed: unexpected conflict')

    await expect(
      dispatch(
        getCourseAction,
        { courseId: courseB.course.id },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('discordServers.list', () => {
  it("lists the caller's own organization's bindings, not another organization's", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, serverId: serverA } =
      seedOrganizationWithBoundServer(testDb.db, 'Org A')
    seedOrganizationWithBoundServer(testDb.db, 'Org B')

    const result = await dispatch(
      listDiscordServersAction,
      {},
      { organizationId: orgA, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.serverId).toBe(serverA)
  })

  // TEN-8: "a removed binding is shown as removed rather than omitted" —
  // see `docs/DECISIONS.md` for why this slice chose to show it.
  it('shows a removed binding as removed, not omitted', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )
    discordServers.removeDiscordServerBinding(
      organizationId,
      serverId,
      testDb.db
    )

    const result = await dispatch(
      listDiscordServersAction,
      {},
      { organizationId, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.serverId).toBe(serverId)
    expect(result[0]?.removedAt).not.toBeNull()
  })
})

describe('jobs.get', () => {
  it("reads a pending job's status, with a null result before it has run", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    const enqueued = jobs.enqueueJob(
      organizationId,
      {
        kind: 'discordServers.scaffold',
        payload: { courseId: 'course-1' },
        maxAttempts: 5,
      },
      testDb.db
    )

    const result = await dispatch(
      getJobAction,
      { jobId: enqueued.id },
      { organizationId, db: testDb.db }
    )

    expect(result).toMatchObject({
      id: enqueued.id,
      kind: 'discordServers.scaffold',
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      result: null,
    })
  })

  // JOB-6: `payload` is never on this action's own response — checked
  // against the actual response shape (`Object.keys`), not against the
  // repo's own row, so a future rework cannot quietly widen `toJobStatus`
  // back to including it without this test catching it.
  it("never hands back a job's payload, even while it is still pending", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    const enqueued = jobs.enqueueJob(
      organizationId,
      {
        kind: 'roster.import',
        payload: { courseId: 'course-1', csvText: 'Ada,ada@example.edu' },
        maxAttempts: 5,
      },
      testDb.db
    )

    const result = await dispatch(
      getJobAction,
      { jobId: enqueued.id },
      { organizationId, db: testDb.db }
    )

    expect(Object.keys(result)).not.toContain('payload')
    expect(JSON.stringify(result)).not.toMatch(/ada@example\.edu/)
  })

  // JOB-6: the platform-level guarantee this whole slice is about — a
  // caller reading a *finished* job back cannot recover the roster CSV
  // (names, emails, Discord handles) it was given, through this action's
  // own response shape, not merely by inspecting the repo layer. The
  // handler's own `result` (the report) is deliberately left out of this
  // assertion's own search string — a report is this job's outcome, and is
  // still meant to be readable back (this file's own "reads a succeeded
  // job's parsed result" test, below, covers that); the CSV this job was
  // *given* is the thing this test proves is gone.
  it("a finished roster.import job's response carries none of the roster CSV it was given", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    const enqueued = jobs.enqueueJob(
      organizationId,
      {
        kind: 'roster.import',
        payload: {
          courseId: 'course-1',
          csvText:
            'First,Last,Email,Discord,GitHub\nAda,Lovelace,ada@example.edu,adalovelace,',
        },
        maxAttempts: 1,
      },
      testDb.db
    )
    const claimed = jobs.claimNextJob(
      ['roster.import'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )
    if (!claimed) throw new Error('expected a claim')
    jobs.completeJob(
      organizationId,
      claimed.id,
      { owner: 'worker-1', claimExpiresAt: claimed.claimExpiresAt! },
      testDb.db,
      { peopleCreated: 1, channelsCreated: 1 }
    )

    const result = await dispatch(
      getJobAction,
      { jobId: enqueued.id },
      { organizationId, db: testDb.db }
    )

    expect(result.status).toBe('succeeded')
    expect(Object.keys(result)).not.toContain('payload')
    expect(JSON.stringify(result)).not.toMatch(/ada@example\.edu|adalovelace/)
  })

  // What makes the queue usable — a succeeded job's report is readable back
  // through the action layer, parsed rather than a raw JSON string.
  it("reads a succeeded job's parsed result", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    const enqueued = jobs.enqueueJob(
      organizationId,
      { kind: 'noop', payload: {}, maxAttempts: 1 },
      testDb.db
    )
    const claimed = jobs.claimNextJob(
      ['noop'],
      { owner: 'worker-1', leaseMs: 60_000 },
      testDb.db
    )
    if (!claimed) throw new Error('expected a claim')
    jobs.completeJob(
      organizationId,
      claimed.id,
      { owner: 'worker-1', claimExpiresAt: claimed.claimExpiresAt! },
      testDb.db,
      { created: ['general'], alreadyPresent: [] }
    )

    const result = await dispatch(
      getJobAction,
      { jobId: enqueued.id },
      { organizationId, db: testDb.db }
    )

    expect(result.status).toBe('succeeded')
    expect(result.result).toEqual({
      created: ['general'],
      alreadyPresent: [],
    })
  })

  // TEN-5: refuses another organization's job the same not-found-shaped way
  // every other read does.
  it("refuses another organization's job", async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganizationWithProject(testDb.db, 'Org A').organizationId
    const orgB = seedOrganizationWithProject(testDb.db, 'Org B').organizationId
    const enqueued = jobs.enqueueJob(
      orgA,
      { kind: 'noop', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    await expect(
      dispatch(
        getJobAction,
        { jobId: enqueued.id },
        { organizationId: orgB, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('jobs.list (JOB-2)', () => {
  // The defect JOB-2 names directly: `jobs.get` needs an id the caller
  // already holds, and a session that dispatched a job yesterday, then
  // closed, holds none today. This test never calls `jobs.get` with the
  // failed job's id at all — the only way this listing can name it is by
  // actually listing the organization's jobs, the way a fresh session
  // would have to.
  it('a job that failed permanently in an earlier session appears, with its error and attempt count', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    const enqueued = jobs.enqueueJob(
      organizationId,
      {
        kind: 'roster.import',
        payload: { courseId: 'course-1' },
        maxAttempts: 1,
      },
      testDb.db
    )
    const claimed = jobs.claimNextJob(
      ['roster.import'],
      { owner: 'e2e-worker', leaseMs: 60_000 },
      testDb.db
    )
    if (!claimed) throw new Error('expected a claim')
    jobs.markJobFailed(
      organizationId,
      claimed.id,
      { owner: 'e2e-worker', claimExpiresAt: claimed.claimExpiresAt! },
      'exhausted attempts: upstream timed out',
      testDb.db
    )

    const result = await dispatch(
      listJobsAction,
      {},
      { organizationId, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: enqueued.id,
      status: 'failed',
      attempts: 1,
      maxAttempts: 1,
      lastError: 'exhausted attempts: upstream timed out',
    })
  })

  // JOB-6: no entry in a listing response carries a job's payload —
  // asserted against the actual response shape, the same discipline
  // `jobs.get`'s own equivalent tests above already hold themselves to,
  // not merely inferred from the type.
  it("never hands back a job's payload, for any job in the listing", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    jobs.enqueueJob(
      organizationId,
      {
        kind: 'roster.import',
        payload: { courseId: 'course-1', csvText: 'Ada,ada@example.edu' },
        maxAttempts: 5,
      },
      testDb.db
    )

    const result = await dispatch(
      listJobsAction,
      {},
      { organizationId, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(Object.keys(result[0]!)).not.toContain('payload')
    expect(JSON.stringify(result)).not.toMatch(/ada@example\.edu/)
  })

  it("does not include another organization's jobs", async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganizationWithProject(testDb.db, 'Org A').organizationId
    const orgB = seedOrganizationWithProject(testDb.db, 'Org B').organizationId
    jobs.enqueueJob(orgA, { kind: 'a', payload: {}, maxAttempts: 1 }, testDb.db)
    jobs.enqueueJob(orgB, { kind: 'b', payload: {}, maxAttempts: 1 }, testDb.db)

    const result = await dispatch(
      listJobsAction,
      {},
      { organizationId: orgA, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe('a')
  })

  // Bounded, not merely defaulted — a caller cannot ask past
  // `MAX_JOBS_LIST_LIMIT` and get everything anyway. Refused at input
  // validation (`ActionInputError`), the same shape `costLedger.setSpendingCap`'s
  // own `.max(MAX_SPENDING_CAP_AMOUNT)` already takes for an out-of-range
  // number (`actions/cost-ledger.ts`).
  it('refuses a limit above the maximum, rather than listing every job', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    jobs.enqueueJob(
      organizationId,
      { kind: 'a', payload: {}, maxAttempts: 1 },
      testDb.db
    )

    await expect(
      dispatch(
        listJobsAction,
        { limit: 100_000 },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionInputError)
  })

  it('defaults to a bounded listing when no limit is given', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganizationWithProject(testDb.db).organizationId
    for (let i = 0; i < 3; i++) {
      jobs.enqueueJob(
        organizationId,
        { kind: `k${i}`, payload: {}, maxAttempts: 1 },
        testDb.db
      )
    }

    const result = await dispatch(
      listJobsAction,
      {},
      { organizationId, db: testDb.db }
    )

    expect(result).toHaveLength(3)
  })
})
