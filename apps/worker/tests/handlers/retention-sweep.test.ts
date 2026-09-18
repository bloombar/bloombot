/**
 * `retention.sweep` (DATA-8, `docs/SPEC.md` §49) — against a real,
 * throwaway database. Fails without this slice's code: before it,
 * `apps/worker` registered no `retention.sweep` job kind at all, and
 * nothing ever permanently removed what DATA-7's soft delete released.
 *
 * `runRetentionSweep` itself is exercised directly, with an explicit `now`
 * (this file's own boundary tests need exact control over "how old is old
 * enough" — `slide-machine`'s own `purgeExpiredSoftDeletes(olderThanDays,
 * now)` is the shape `runRetentionSweep`'s own signature copies).
 * `createRetentionSweepHandler`/`ensureRetentionSweepScheduled` are
 * exercised separately, through the real queue (`@bloombot/jobs`'s own
 * `runNextJob`), for the scheduling behaviour that only makes sense there.
 */

import { randomUUID } from 'node:crypto'

import {
  accounts,
  conversations,
  courseInstructionRevisions,
  courses,
  jobs,
  organizations,
  people,
  projects,
  schema,
} from '@bloombot/db'
import { eq } from 'drizzle-orm'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import { afterEach, describe, expect, it } from 'vitest'

import { REMOVE_DELETED_CONTENT_BYTES_JOB_KIND } from '../../src/handlers/content-deletions.js'
import {
  createRetentionSweepHandler,
  ensureRetentionSweepScheduled,
  runRetentionSweep,
  RETENTION_SWEEP_INTERVAL_MS,
  RETENTION_SWEEP_JOB_KIND,
} from '../../src/handlers/retention-sweep.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

const retryPolicy: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }
const RETENTION_DAYS = 30
const WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

/** A minimal organization, with one instructor account — the smallest seed most of this file's own tests need. */
function seedOrganization(db: TestDatabase['db']) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    db
  )
  const owner = accounts.createAccount(
    organizationId,
    {
      email: `owner-${organizationId}@example.edu`,
      displayName: 'Owner',
      role: 'owner',
    },
    db
  )
  return { organizationId, owner }
}

/** Force a project's own `deletedAt` to an exact epoch millisecond — `softDeleteProject` always stamps `Date.now()`, so a boundary test overwrites it directly afterward rather than faking the system clock. */
function backdateProject(
  db: TestDatabase['db'],
  projectId: string,
  deletedAt: number
) {
  db.update(schema.projects)
    .set({ deletedAt })
    .where(eq(schema.projects.id, projectId))
    .run()
}

describe('runRetentionSweep', () => {
  it('removes a record marked deleted longer ago than the window, and leaves one marked more recently untouched', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    const now = Date.now()

    const old = projects.createProject(
      organizationId,
      { name: 'Old' },
      testDb.db
    )
    projects.softDeleteProject(organizationId, old.id, owner.id, testDb.db)
    backdateProject(testDb.db, old.id, now - WINDOW_MS - 1_000)

    const recent = projects.createProject(
      organizationId,
      { name: 'Recent' },
      testDb.db
    )
    projects.softDeleteProject(organizationId, recent.id, owner.id, testDb.db)

    const report = runRetentionSweep(
      RETENTION_DAYS,
      now,
      testDb.db,
      createFakeLogger()
    )

    expect(report.projectsRemoved).toBe(1)
    expect(
      testDb.db
        .select()
        .from(schema.projects)
        .all()
        .map((row) => row.id)
    ).toEqual([recent.id])
  })

  it('exercises the boundary at exactly the window — deletedAt === now - window is removed', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    const now = Date.now()

    const project = projects.createProject(
      organizationId,
      { name: 'Boundary' },
      testDb.db
    )
    projects.softDeleteProject(organizationId, project.id, owner.id, testDb.db)
    backdateProject(testDb.db, project.id, now - WINDOW_MS)

    const report = runRetentionSweep(
      RETENTION_DAYS,
      now,
      testDb.db,
      createFakeLogger()
    )

    expect(report.projectsRemoved).toBe(1)
    expect(testDb.db.select().from(schema.projects).all()).toHaveLength(0)
  })

  it('DELETED_DATA_RETENTION_DAYS=0 sweeps nothing', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    const now = Date.now()

    const project = projects.createProject(
      organizationId,
      { name: 'Old' },
      testDb.db
    )
    projects.softDeleteProject(organizationId, project.id, owner.id, testDb.db)
    backdateProject(testDb.db, project.id, now - WINDOW_MS - 1_000)

    const report = runRetentionSweep(0, now, testDb.db, createFakeLogger())

    expect(report).toEqual({
      organizationsRemoved: 0,
      projectsRemoved: 0,
      coursesRemoved: 0,
      peopleRemoved: 0,
      conversationsRemoved: 0,
      accountsRemoved: 0,
      failures: 0,
    })
    expect(testDb.db.select().from(schema.projects).all()).toHaveLength(1)
  })

  // DATA-8 rework, must-fix 1/2 — reproduces the review's own finding:
  // before the fix, this org's rows were removed (`organizationsRemoved: 1`)
  // but the byte-removal job's own enqueue threw `SQLITE_CONSTRAINT_FOREIGNKEY`
  // (`jobs.organizationId` cannot name an organization already gone),
  // counted as `failures: 1` *for the same organization already removed*,
  // and queued zero byte-removal jobs — a permanent, unreachable leak of
  // the attachment this test seeds. A second, surviving organization is
  // what a real deployment always has (its own platform administrator's
  // personal organization, if nothing else) — seeded here for exactly that
  // reason, so the byte-removal job has somewhere valid to attach to.
  it('removes an organization past its window, and durably queues its course’s byte removal against a surviving organization — never removed rows with unqueued bytes', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    // A second, surviving organization — `jobs.organizationId`'s own
    // foreign key needs one that is not the organization being deleted.
    seedOrganization(testDb.db)
    const now = Date.now()

    const project = projects.createProject(
      organizationId,
      { name: 'Fall 2026' },
      testDb.db
    )
    const courseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Web Design',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!courseResult.ok) throw new Error('seed course creation failed')
    const courseId = courseResult.course.id

    testDb.db
      .insert(schema.courseAttachments)
      .values({
        id: randomUUID(),
        organizationId,
        courseId,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
        status: 'ready',
        providerFileId: 'file_org_abc123',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    organizations.softDeleteOrganization(organizationId, owner.id, testDb.db)
    testDb.db
      .update(schema.organizations)
      .set({ deletedAt: now - WINDOW_MS - 1_000 })
      .where(eq(schema.organizations.id, organizationId))
      .run()

    const logger = createFakeLogger()
    const report = runRetentionSweep(RETENTION_DAYS, now, testDb.db, logger)

    // The organization is genuinely gone, and counted as removed — not as
    // a failure alongside it.
    expect(report.organizationsRemoved).toBe(1)
    expect(report.failures).toBe(0)
    expect(
      testDb.db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organizationId))
        .all()
    ).toHaveLength(0)

    // The byte-removal job is durably queued, naming the removed
    // organization's own course and its attachment's provider file id —
    // attached to the *surviving* organization (`jobs.organizationId`),
    // not the one just deleted.
    const queued = testDb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, REMOVE_DELETED_CONTENT_BYTES_JOB_KIND))
      .all()
    expect(queued).toHaveLength(1)
    expect(queued[0]?.organizationId).not.toBe(organizationId)
    const payload = JSON.parse(queued[0]?.payload ?? '{}') as {
      organizationId?: string
      courses: {
        courseId: string
        attachments: { providerFileId: string | null }[]
      }[]
    }
    // The payload names the organization whose bytes these actually are —
    // the deleted one — separately from the job row's own organization.
    expect(payload.organizationId).toBe(organizationId)
    expect(payload.courses).toHaveLength(1)
    expect(payload.courses[0]?.courseId).toBe(courseId)
    expect(payload.courses[0]?.attachments[0]?.providerFileId).toBe(
      'file_org_abc123'
    )
  })

  // DATA-8 rework, round 2 must-fix 1/cheap-fix 4 — reproduces the review's
  // own finding: with no surviving organization to attach the byte-removal
  // job to, the round-one code still deleted this organization's rows
  // anyway, orphaning its attachment forever while reporting a clean
  // `{organizationsRemoved: 1, failures: 0}`. Fails without the fix: the
  // organization row and its course would both be gone, and zero jobs
  // queued.
  it('with no surviving organization, skips the organization rather than deleting rows it cannot queue bytes for', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    const now = Date.now()

    const project = projects.createProject(
      organizationId,
      { name: 'Fall 2026' },
      testDb.db
    )
    const courseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Web Design',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!courseResult.ok) throw new Error('seed course creation failed')
    const courseId = courseResult.course.id
    testDb.db
      .insert(schema.courseAttachments)
      .values({
        id: randomUUID(),
        organizationId,
        courseId,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
        status: 'ready',
        providerFileId: 'file_orphan_risk',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    organizations.softDeleteOrganization(organizationId, owner.id, testDb.db)
    testDb.db
      .update(schema.organizations)
      .set({ deletedAt: now - WINDOW_MS - 1_000 })
      .where(eq(schema.organizations.id, organizationId))
      .run()

    const logger = createFakeLogger()
    const report = runRetentionSweep(RETENTION_DAYS, now, testDb.db, logger)

    // Not removed, not silently dropped — counted as a failure, retried.
    expect(report.organizationsRemoved).toBe(0)
    expect(report.failures).toBe(1)
    expect(
      testDb.db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, organizationId))
        .all()
    ).toHaveLength(1)
    expect(
      testDb.db
        .select()
        .from(schema.courses)
        .where(eq(schema.courses.id, courseId))
        .all()
    ).toHaveLength(1)
    expect(testDb.db.select().from(schema.jobs).all()).toHaveLength(0)
    expect(logger.warnCalls.length).toBeGreaterThanOrEqual(1)
  })

  // The round's own second reproduction: this is not limited to "the
  // platform's only organization" (an earlier version of D-140 said it
  // was) — two organizations, both past their window, with no *live* one
  // between them, hits the identical gap for both.
  it('with two expired organizations and no live one, skips both — not only "the platform’s only organization"', () => {
    testDb = createTestDatabase()
    const first = seedOrganization(testDb.db)
    const second = seedOrganization(testDb.db)
    const now = Date.now()

    for (const { organizationId, owner } of [first, second]) {
      organizations.softDeleteOrganization(organizationId, owner.id, testDb.db)
      testDb.db
        .update(schema.organizations)
        .set({ deletedAt: now - WINDOW_MS - 1_000 })
        .where(eq(schema.organizations.id, organizationId))
        .run()
    }

    const report = runRetentionSweep(
      RETENTION_DAYS,
      now,
      testDb.db,
      createFakeLogger()
    )

    expect(report.organizationsRemoved).toBe(0)
    expect(report.failures).toBe(2)
    expect(testDb.db.select().from(schema.organizations).all()).toHaveLength(2)
  })

  it('removes a course past its window and enqueues the content-deletion job with its own byte ids', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    const now = Date.now()

    const project = projects.createProject(
      organizationId,
      { name: 'Fall 2026' },
      testDb.db
    )
    const courseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Web Design',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!courseResult.ok) throw new Error('seed course creation failed')
    const courseId = courseResult.course.id

    testDb.db
      .insert(schema.courseAttachments)
      .values({
        id: randomUUID(),
        organizationId,
        courseId,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
        status: 'ready',
        providerFileId: 'file_abc123',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    courses.softDeleteCourse(organizationId, courseId, owner.id, testDb.db)
    testDb.db
      .update(schema.courses)
      .set({ deletedAt: now - WINDOW_MS - 1_000 })
      .where(eq(schema.courses.id, courseId))
      .run()

    const report = runRetentionSweep(
      RETENTION_DAYS,
      now,
      testDb.db,
      createFakeLogger()
    )

    expect(report.coursesRemoved).toBe(1)
    expect(
      courses.getCourse(organizationId, courseId, testDb.db)
    ).toBeUndefined()

    const queued = testDb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, REMOVE_DELETED_CONTENT_BYTES_JOB_KIND))
      .all()
    expect(queued).toHaveLength(1)
    const payload = JSON.parse(queued[0]?.payload ?? '{}') as {
      courses: {
        courseId: string
        attachments: { providerFileId: string | null }[]
      }[]
    }
    expect(payload.courses).toHaveLength(1)
    expect(payload.courses[0]?.courseId).toBe(courseId)
    expect(payload.courses[0]?.attachments[0]?.providerFileId).toBe(
      'file_abc123'
    )
  })

  it('removes a person and their own conversation once both are past the window', () => {
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    const now = Date.now()

    const project = projects.createProject(
      organizationId,
      { name: 'Fall 2026' },
      testDb.db
    )
    const courseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Web Design',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!courseResult.ok) throw new Error('seed course creation failed')
    const courseId = courseResult.course.id

    const person = people.createPerson(
      organizationId,
      { displayName: 'Student' },
      testDb.db
    )
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId, personId: person.id, surface: 'web' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    people.softDeletePerson(organizationId, person.id, owner.id, testDb.db)
    testDb.db
      .update(schema.people)
      .set({ deletedAt: now - WINDOW_MS - 1_000 })
      .where(eq(schema.people.id, person.id))
      .run()
    testDb.db
      .update(schema.conversations)
      .set({ deletedAt: now - WINDOW_MS - 1_000 })
      .where(eq(schema.conversations.id, conversation.id))
      .run()

    const report = runRetentionSweep(
      RETENTION_DAYS,
      now,
      testDb.db,
      createFakeLogger()
    )

    expect(report.peopleRemoved).toBe(1)
    expect(
      people.getPerson(organizationId, person.id, testDb.db)
    ).toBeUndefined()
    expect(testDb.db.select().from(schema.conversations).all()).toHaveLength(0)
    expect(testDb.db.select().from(schema.messages).all()).toHaveLength(0)
  })

  it('removes an account with nothing blocking it, past the window', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganization(testDb.db)
    const now = Date.now()

    const account = accounts.createAccount(
      organizationId,
      { email: 'gone@example.edu', displayName: 'Gone', role: 'instructor' },
      testDb.db
    )
    accounts.softDeleteAccount(account.id, account.id, testDb.db)
    testDb.db
      .update(schema.accounts)
      .set({ deletedAt: now - WINDOW_MS - 1_000 })
      .where(eq(schema.accounts.id, account.id))
      .run()

    const report = runRetentionSweep(
      RETENTION_DAYS,
      now,
      testDb.db,
      createFakeLogger()
    )

    expect(report.accountsRemoved).toBe(1)
    expect(accounts.getAccountById(account.id, testDb.db)).toBeUndefined()
  })

  it('a record this sweep cannot remove is logged, skipped, and left marked for the next run to retry', () => {
    // An account still named as `courses.savedByAccountId` (a real, NOT
    // NULL foreign key `accounts.ts#permanentlyDeleteAccount`'s own doc
    // comment leaves untouched) cannot actually be removed — the same
    // deliberate partial failure that function's own doc comment
    // describes.
    testDb = createTestDatabase()
    const { organizationId, owner } = seedOrganization(testDb.db)
    const now = Date.now()

    const project = projects.createProject(
      organizationId,
      { name: 'Fall 2026' },
      testDb.db
    )
    const courseResult = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Web Design',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!courseResult.ok) throw new Error('seed course creation failed')
    // A real, `NOT NULL` foreign key to `owner` that
    // `accounts.ts#permanentlyDeleteAccount` deliberately leaves untouched
    // (that function's own doc comment) — this is what makes the account
    // below genuinely unremovable, not a contrived failure.
    courseInstructionRevisions.createRevision(
      organizationId,
      {
        courseId: courseResult.course.id,
        instructions: 'Be kind.',
        savedByAccountId: owner.id,
      },
      testDb.db
    )

    accounts.softDeleteAccount(owner.id, owner.id, testDb.db)
    testDb.db
      .update(schema.accounts)
      .set({ deletedAt: now - WINDOW_MS - 1_000 })
      .where(eq(schema.accounts.id, owner.id))
      .run()

    const logger = createFakeLogger()
    const report = runRetentionSweep(RETENTION_DAYS, now, testDb.db, logger)

    expect(report.failures).toBeGreaterThanOrEqual(1)
    // Still there, raw — the transaction `permanentlyDeleteAccount` opened
    // rolled itself back, and nothing about the tombstone changed.
    // `accounts.getAccountById` itself still reports "gone" (DATA-9: it
    // filters on `deletedAt`, which is exactly what is still set), so the
    // row is read directly here instead.
    expect(
      testDb.db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, owner.id))
        .all()
    ).toHaveLength(1)
    expect(logger.warnCalls.length).toBeGreaterThanOrEqual(1)

    // Running the sweep again finds the identical, still-marked account —
    // it retries, rather than forgetting about it.
    const secondReport = runRetentionSweep(
      RETENTION_DAYS,
      now,
      testDb.db,
      createFakeLogger()
    )
    expect(secondReport.failures).toBeGreaterThanOrEqual(1)
  })
})

describe('ensureRetentionSweepScheduled', () => {
  it('is enqueued at worker startup', () => {
    testDb = createTestDatabase()
    seedOrganization(testDb.db)

    ensureRetentionSweepScheduled('', Date.now(), testDb.db, createFakeLogger())

    const queued = testDb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, RETENTION_SWEEP_JOB_KIND))
      .all()
    expect(queued).toHaveLength(1)
  })

  // DATA-8 rework, cheap-fix 4 — before it, the startup call always passed
  // `now + RETENTION_SWEEP_INTERVAL_MS` (24h), the identical delay the
  // self-reschedule uses; a deployment down for a month would then wait a
  // further day past its own restart before the first sweep ran at all.
  it('schedules the startup sweep to run promptly, not a day late', () => {
    testDb = createTestDatabase()
    seedOrganization(testDb.db)
    const before = Date.now()

    ensureRetentionSweepScheduled('', before, testDb.db, createFakeLogger())

    const queued = testDb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, RETENTION_SWEEP_JOB_KIND))
      .all()
    expect(queued).toHaveLength(1)
    // Comfortably under the 24h self-reschedule interval — this is "now",
    // not "a day from now".
    expect(queued[0]?.nextAttemptAt ?? Infinity).toBeLessThan(before + 60_000)
  })

  it('does nothing when no organization exists yet — nothing to attach the job to, nothing to sweep', () => {
    testDb = createTestDatabase()

    ensureRetentionSweepScheduled('', Date.now(), testDb.db, createFakeLogger())

    expect(testDb.db.select().from(schema.jobs).all()).toHaveLength(0)
  })

  it('does not enqueue a second sweep while one is already queued', () => {
    testDb = createTestDatabase()
    seedOrganization(testDb.db)

    ensureRetentionSweepScheduled('', Date.now(), testDb.db, createFakeLogger())
    ensureRetentionSweepScheduled('', Date.now(), testDb.db, createFakeLogger())

    const queued = testDb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, RETENTION_SWEEP_JOB_KIND))
      .all()
    expect(queued).toHaveLength(1)
  })
})

describe('retention.sweep handler, run through the real queue', () => {
  it('enqueues its own successor once it completes, and running it twice does not leave two live sweep jobs queued', async () => {
    testDb = createTestDatabase()
    seedOrganization(testDb.db)

    const handlers = new HandlerRegistry()
    const logger = createFakeLogger()
    handlers.register(
      RETENTION_SWEEP_JOB_KIND,
      createRetentionSweepHandler({ retentionDays: RETENTION_DAYS, logger })
    )

    jobs.enqueueJob(
      (organizations.pickReferenceOrganizationId(testDb.db) as string) ?? '',
      { kind: RETENTION_SWEEP_JOB_KIND, payload: {}, maxAttempts: 5 },
      testDb.db
    )

    const before = Date.now()
    const result = await runNextJob({
      db: testDb.db,
      logger,
      handlers,
      owner: 'test-worker',
      leaseMs: 60_000,
      handlerTimeoutMs: 5_000,
      retryPolicy,
    })
    expect(result.outcome).toBe('succeeded')

    // Exactly one sweep job is left queued — the one this run just
    // completed is terminal (`succeeded`), and exactly one successor was
    // scheduled in its place.
    const queued = testDb.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, RETENTION_SWEEP_JOB_KIND))
      .all()
    const live = queued.filter((row) => row.status !== 'succeeded')
    expect(live).toHaveLength(1)
    // DATA-8 rework, round 2 cheap-fix 3 — pins the *interval*, not merely
    // "a successor exists": the "schedules the startup sweep to run
    // promptly" test above already pins the startup path to well under a
    // day, but nothing here previously distinguished a self-reschedule
    // that waits the full `RETENTION_SWEEP_INTERVAL_MS` from one that
    // (wrongly) reused the startup path's `Date.now()` — a bug like that
    // would leave both tests green while the worker spun the sweep
    // continuously.
    expect(live[0]?.nextAttemptAt ?? 0).toBeGreaterThan(
      before + RETENTION_SWEEP_INTERVAL_MS - 5_000
    )
  })
})
