/**
 * `roster.import` (ROST-9): enqueues rather than working inline — the same
 * "action enqueues, the worker does the work" shape `discordServers.scaffold`
 * already holds itself to (`tests/discord-servers.test.ts`). Dispatching it
 * creates exactly one job row, carrying the course id and the roster's own
 * CSV text, and reaches no Discord state or person at all — this package
 * holds no Discord client and no CSV parser to reach either with.
 *
 * ROST-20: it also writes exactly one roster-import acknowledgement,
 * carrying the account, course, filename, version and the job id it
 * enqueued — in the same transaction as the enqueue, so an import that
 * fails to start writes none.
 */

import {
  accounts,
  courses,
  jobs,
  projects,
  rosterImportAcknowledgements,
  schema,
  type Database,
} from '@bloombot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  importRosterAction,
  listRosterAcknowledgementsAction,
} from '../src/actions/roster.js'
import { dispatch } from '../src/dispatch.js'
import { ActionInputError, ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithBoundServer } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One bare course, no categories — enough for `roster.import`'s own policy to resolve. */
function seedCourse(organizationId: string, db: Database): string {
  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      enabled: true,
      adminsRole: 'admins-tc',
      studentsRole: 'students-tc',
      categories: [{ name: 'Test Course - STUDENTS 01', channels: [] }],
    },
    db
  )
  if (!courseResult.ok) throw new Error('setup failed: unexpected conflict')
  return courseResult.course.id
}

/** An instructor account — ROST-20's own acknowledging account. */
function seedInstructor(organizationId: string, db: Database): string {
  return accounts.createAccount(
    organizationId,
    {
      email: `instructor-${crypto.randomUUID()}@example.edu`,
      displayName: 'Instructor',
      role: 'instructor',
    },
    db
  ).id
}

function allJobRows(db: Database): jobs.Job[] {
  return db.select().from(schema.jobs).all()
}

function allAcknowledgementRows(
  db: Database
): rosterImportAcknowledgements.RosterImportAcknowledgement[] {
  return db.select().from(schema.rosterImportAcknowledgements).all()
}

const CSV =
  'First,Last,Email,Discord,GitHub\nAda,Lovelace,ada@example.edu,adalovelace,adal'

const ACKNOWLEDGEMENT_VERSION = '2026-09-18'

describe('roster.import (ROST-9/ROST-20)', () => {
  it('enqueues a roster.import job naming the course and carrying the roster text, without doing any work inline', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const accountId = seedInstructor(organizationId, testDb.db)
    const before = allJobRows(testDb.db).length

    const result = await dispatch(
      importRosterAction,
      {
        courseId,
        csvText: CSV,
        filename: 'roster.csv',
        acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
      },
      { organizationId, accountId, db: testDb.db }
    )

    expect(result.jobId).toEqual(expect.any(String))
    const rows = allJobRows(testDb.db)
    expect(rows).toHaveLength(before + 1)
    const created = rows.find((row) => row.id === result.jobId)
    expect(created).toMatchObject({
      organizationId,
      kind: 'roster.import',
      status: 'pending',
    })
    // ROST-15: "checked by default" — an instructor dispatching this
    // action without saying anything about student categories still gets
    // `createStudentCategories: true` and a base name derived from the
    // course's own title on the enqueued payload.
    expect(JSON.parse(created?.payload ?? '{}')).toEqual({
      courseId,
      csvText: CSV,
      createStudentCategories: true,
      studentCategoryBaseName: 'Test Course - STUDENTS',
    })
  })

  // ROST-15: an explicit request travels through untouched — the panel's
  // own checkbox and base-name field (`apps/web`'s `RosterImport.tsx`)
  // both reach the payload exactly as given, never silently overridden by
  // this action's own defaults.
  it('carries an explicit createStudentCategories/studentCategoryBaseName through to the job payload untouched', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const accountId = seedInstructor(organizationId, testDb.db)

    const result = await dispatch(
      importRosterAction,
      {
        courseId,
        csvText: CSV,
        createStudentCategories: false,
        studentCategoryBaseName: 'Custom Base',
        filename: 'roster.csv',
        acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
      },
      { organizationId, accountId, db: testDb.db }
    )

    const created = allJobRows(testDb.db).find((row) => row.id === result.jobId)
    expect(JSON.parse(created?.payload ?? '{}')).toMatchObject({
      createStudentCategories: false,
      studentCategoryBaseName: 'Custom Base',
    })
  })

  // TEN-5: refuses another organization's course the same not-found-shaped
  // way every other action does, enqueueing nothing.
  it("refuses to import a roster into another organization's course", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org A'
    )
    const courseId = seedCourse(orgA, testDb.db)
    const { organizationId: orgB } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org B'
    )
    const accountId = seedInstructor(orgB, testDb.db)

    await expect(
      dispatch(
        importRosterAction,
        {
          courseId,
          csvText: CSV,
          filename: 'roster.csv',
          acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
        },
        { organizationId: orgB, accountId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(allJobRows(testDb.db)).toHaveLength(0)
  })

  it('refuses an empty upload outright, before it ever reaches the policy', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const accountId = seedInstructor(organizationId, testDb.db)

    await expect(
      dispatch(
        importRosterAction,
        {
          courseId,
          csvText: '',
          filename: 'roster.csv',
          acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
        },
        { organizationId, accountId, db: testDb.db }
      )
    ).rejects.toThrow(ActionInputError)

    expect(allJobRows(testDb.db)).toHaveLength(0)
  })

  // ROST-20's own text: starting an import writes exactly one
  // acknowledgement, carrying the account, course, filename, version and
  // the job id it enqueued.
  it('writes exactly one acknowledgement, carrying the account, course, filename, version and the enqueued job id', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const accountId = seedInstructor(organizationId, testDb.db)

    const result = await dispatch(
      importRosterAction,
      {
        courseId,
        csvText: CSV,
        filename: 'my-roster.csv',
        acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
      },
      { organizationId, accountId, db: testDb.db }
    )

    const acknowledgements = allAcknowledgementRows(testDb.db)
    expect(acknowledgements).toHaveLength(1)
    expect(acknowledgements[0]).toMatchObject({
      organizationId,
      courseId,
      accountId,
      filename: 'my-roster.csv',
      jobId: result.jobId,
      acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
    })
  })

  // ROST-20: an import that fails to start (here, TEN-5's refusal) writes
  // no acknowledgement.
  it('writes no acknowledgement when the import is refused', async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org A'
    )
    const courseId = seedCourse(orgA, testDb.db)
    const { organizationId: orgB } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org B'
    )
    const accountId = seedInstructor(orgB, testDb.db)

    await expect(
      dispatch(
        importRosterAction,
        {
          courseId,
          csvText: CSV,
          filename: 'roster.csv',
          acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
        },
        { organizationId: orgB, accountId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(allAcknowledgementRows(testDb.db)).toHaveLength(0)
  })

  // Rework finding (cheap-fix): the test above only proves a *policy*
  // refusal — one that never reaches `execute` at all — writes nothing; it
  // would still pass if the enqueue and the acknowledgement write were ever
  // split back into two transactions. This is what actually pins the
  // "structurally, not by two calls a crash could split" claim
  // (`actions/roster.ts`'s own module comment, D-136): a bogus `accountId`
  // reaches `execute` and trips `rosterImportAcknowledgements`' own foreign
  // key on `accounts.id` (`dispatch` never validates `accountId` against the
  // `accounts` table itself — it is passed straight through) *inside* the
  // transaction, after `jobs.enqueueJob` has already run — so if the two
  // writes were not atomic, the job row would survive this throw. It does
  // not.
  it('rolls back the enqueue too when the acknowledgement write itself fails inside the transaction', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const bogusAccountId = crypto.randomUUID()
    const before = allJobRows(testDb.db).length

    await expect(
      dispatch(
        importRosterAction,
        {
          courseId,
          csvText: CSV,
          filename: 'roster.csv',
          acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
        },
        { organizationId, accountId: bogusAccountId, db: testDb.db }
      )
    ).rejects.toThrow()

    expect(allJobRows(testDb.db)).toHaveLength(before)
    expect(allAcknowledgementRows(testDb.db)).toHaveLength(0)
  })

  // ROST-20: an unversioned record is exactly what this requirement exists
  // to prevent — refused outright, before the policy runs, the same
  // ActionInputError shape an empty CSV already gets above.
  it('refuses input missing the acknowledgement version', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const accountId = seedInstructor(organizationId, testDb.db)

    await expect(
      dispatch(
        importRosterAction,
        { courseId, csvText: CSV, filename: 'roster.csv' },
        { organizationId, accountId, db: testDb.db }
      )
    ).rejects.toThrow(ActionInputError)

    expect(allJobRows(testDb.db)).toHaveLength(0)
    expect(allAcknowledgementRows(testDb.db)).toHaveLength(0)
  })

  // ROST-20/FILE-4's identical "a self-reported author is a forgeable audit
  // trail" reasoning — refused, not recorded as acknowledged by nobody.
  it('refuses a call with no authenticated account', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)

    await expect(
      dispatch(
        importRosterAction,
        {
          courseId,
          csvText: CSV,
          filename: 'roster.csv',
          acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
        },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(allJobRows(testDb.db)).toHaveLength(0)
    expect(allAcknowledgementRows(testDb.db)).toHaveLength(0)
  })
})

describe('rosterAcknowledgements.listForCourse (ROST-20)', () => {
  it("lists a course's own acknowledgements, newest first", async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const accountId = seedInstructor(organizationId, testDb.db)

    // Two imports fast enough in a test that `Date.now()` could tie —
    // `acknowledgedAt` spied so the second is unambiguously later, the
    // same "control the clock rather than trust real time to separate two
    // calls" approach this ordering claim needs to be provable at all.
    // `mockReturnValue` (not `-Once`), since each dispatch reads the clock
    // twice (`jobs.enqueueJob`'s own `now`, then `acknowledgedAt`).
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000)
    await dispatch(
      importRosterAction,
      {
        courseId,
        csvText: CSV,
        filename: 'first.csv',
        acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
      },
      { organizationId, accountId, db: testDb.db }
    )
    nowSpy.mockReturnValue(2_000)
    await dispatch(
      importRosterAction,
      {
        courseId,
        csvText: CSV,
        filename: 'second.csv',
        acknowledgementVersion: ACKNOWLEDGEMENT_VERSION,
      },
      { organizationId, accountId, db: testDb.db }
    )
    nowSpy.mockRestore()

    const list = await dispatch(
      listRosterAcknowledgementsAction,
      { courseId },
      { organizationId, db: testDb.db }
    )

    expect(list).toHaveLength(2)
    expect(list[0]?.filename).toBe('second.csv')
    expect(list[1]?.filename).toBe('first.csv')
  })

  it("refuses another organization's course the same not-found-shaped way", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org A'
    )
    const courseId = seedCourse(orgA, testDb.db)
    const { organizationId: orgB } = seedOrganizationWithBoundServer(
      testDb.db,
      'Org B'
    )

    await expect(
      dispatch(
        listRosterAcknowledgementsAction,
        { courseId },
        { organizationId: orgB, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})
