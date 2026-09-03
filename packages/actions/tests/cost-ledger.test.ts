/**
 * COST-4's instructor read (`costLedger.organizationUsage`) and COST-3's
 * write (`costLedger.setSpendingCap`) — exercised through `dispatch`, the
 * same tenant-scoping proof every other read in `reads.test.ts` gets: a
 * caller cannot see another organization's usage through this action
 * either.
 */

import {
  accounts,
  costLedger,
  courses,
  organizations,
  people,
  usage,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  organizationUsageAction,
  setSpendingCapAction,
} from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import {
  seedOrganization,
  seedOrganizationWithProject,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One enabled course with a daily limit, in `projectId`'s own organization. */
function seedCourse(
  organizationId: string,
  projectId: string,
  db: TestDatabase['db'],
  overrides: { adminsRole?: string; studentsRole?: string } = {}
) {
  const result = courses.createCourse(
    organizationId,
    {
      projectId,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: overrides.adminsRole ?? 'admins-tc',
      studentsRole: overrides.studentsRole ?? 'students-tc',
      maxRequestsPerDay: 2,
      categories: [],
    },
    db
  )
  if (!result.ok) throw new Error('seed course creation failed')
  return result.course
}

describe('costLedger.organizationUsage', () => {
  it("reads the caller's own organization's usage and near-limit students, and not another organization's", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Org A Term'
    )
    const otherOrganizationId = organizations.createOrganization(
      crypto.randomUUID(),
      { name: 'Org B', isPersonal: false },
      testDb.db
    ).id
    const course = seedCourse(organizationId, projectId, testDb.db)
    const person = people.createPerson(
      organizationId,
      { displayName: 'Student' },
      testDb.db
    )
    const day = '2026-08-31'
    // Two of two — at the course's own limit, comfortably over the 80%
    // near-limit threshold.
    usage.incrementUsage(organizationId, course.id, person.id, day, testDb.db)
    usage.incrementUsage(organizationId, course.id, person.id, day, testDb.db)
    costLedger.recordCostLedgerEntry(
      organizationId,
      {
        courseId: course.id,
        personId: person.id,
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 10,
        costMicros: 500,
        measurement: 'measured',
      },
      testDb.db
    )

    const result = await dispatch(
      organizationUsageAction,
      { day },
      { organizationId, db: testDb.db }
    )

    expect(result.organizationId).toBe(organizationId)
    expect(result.totalCostMicros).toBe(500)
    // Recorded `measurement: 'measured'` above — none of this total is an
    // estimate.
    expect(result.totalEstimatedCostMicros).toBe(0)
    expect(result.courses).toEqual([
      {
        courseId: course.id,
        courseTitle: 'Test Course',
        costMicros: 500,
        estimatedCostMicros: 0,
        callCount: 1,
      },
    ])
    expect(result.studentsNearLimit).toEqual([
      {
        courseId: course.id,
        courseTitle: 'Test Course',
        personId: person.id,
        personDisplayName: 'Student',
        count: 2,
        maxRequestsPerDay: 2,
      },
    ])

    // The other organization's own read sees none of this.
    const otherResult = await dispatch(
      organizationUsageAction,
      { day },
      { organizationId: otherOrganizationId, db: testDb.db }
    )
    expect(otherResult.totalCostMicros).toBe(0)
    expect(otherResult.courses).toEqual([])
    expect(otherResult.studentsNearLimit).toEqual([])
  })

  it('rejects a malformed day rather than silently reading against the wrong boundary', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        organizationUsageAction,
        { day: '8/31/2026' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow()
  })

  // TEN-2/TEN-5, read directly at the dispatch level rather than only over
  // HTTP (`apps/api/tests/tenant-isolation.test.ts`'s own generic (a)/(b)/(c)
  // matrix already covers this route, but that test never dispatches
  // against an organization id that does not exist at all — only a real,
  // foreign one whose own membership check refuses first). `resolve`
  // (`actions/cost-ledger.ts`) looks the organization up by
  // `context.organizationId` alone; an id naming nothing resolves to
  // `undefined`, the same ACT-3 refusal every other not-found gives.
  it('refuses not-found-shaped for an organization id that does not exist at all', async () => {
    testDb = createTestDatabase()

    await expect(
      dispatch(
        organizationUsageAction,
        { day: '2026-08-31' },
        { organizationId: crypto.randomUUID(), db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('costLedger.setSpendingCap (COST-3)', () => {
  it("an owner sets a cap in dollars, stored in micros at the right magnitude — asserts the stored value, not the action's own return", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const result = await dispatch(
      setSpendingCapAction,
      { capAmount: 12.5 },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    expect(result).toEqual({ organizationId, spendingCapMicros: 12_500_000 })
    // Read back independently of the action's own return, through the repo
    // this action wraps — proves the write actually landed, not merely that
    // the action reported one.
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
        ?.spendingCapMicros
    ).toBe(12_500_000)
  })

  // COST-3's own text: "clearing the cap ... must be possible and must be
  // distinguishable from setting it to zero, which would block everything."
  // Fails without the fix: a caller with no way to send `null` — or an
  // action that coerced `null` to `0` — could set a cap but never remove
  // one, and a `0` cap and "no cap" would be indistinguishable in storage.
  it('clearing the cap (capAmount: null) is distinguishable from setting it to 0 — one blocks every call, the other holds no cap at all', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    const zeroed = await dispatch(
      setSpendingCapAction,
      { capAmount: 0 },
      { organizationId, db: testDb.db, accountId: owner.id }
    )
    expect(zeroed.spendingCapMicros).toBe(0)
    // A `0` cap blocks every call — the organization has spent nothing yet,
    // and `0 >= 0` is already true.
    expect(costLedger.hasReachedSpendingCap(organizationId, testDb.db)).toBe(
      true
    )

    const cleared = await dispatch(
      setSpendingCapAction,
      { capAmount: null },
      { organizationId, db: testDb.db, accountId: owner.id }
    )
    expect(cleared.spendingCapMicros).toBeNull()
    // Cleared, not zeroed — no cap at all, so nothing is blocked by one.
    expect(costLedger.hasReachedSpendingCap(organizationId, testDb.db)).toBe(
      false
    )
  })

  it('refuses a caller who is not an owner', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'instructor@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )

    await expect(
      dispatch(
        setSpendingCapAction,
        { capAmount: 5 },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
        ?.spendingCapMicros
    ).toBeNull()
  })

  it('refuses when dispatch was given no authenticated caller at all', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)

    await expect(
      dispatch(
        setSpendingCapAction,
        { capAmount: 5 },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it("refuses an owner in a different organization from the one being acted on — an owner elsewhere cannot set this organization's cap", async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganization(testDb.db)
    const orgB = seedOrganization(testDb.db)
    const ownerOfA = accounts.createAccount(
      orgA,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        setSpendingCapAction,
        { capAmount: 5 },
        { organizationId: orgB, db: testDb.db, accountId: ownerOfA.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      organizations.getOrganizationById(orgB, testDb.db)?.spendingCapMicros
    ).toBeNull()
  })

  it('refuses not-found-shaped for an organization id that does not exist at all', async () => {
    testDb = createTestDatabase()

    await expect(
      dispatch(
        setSpendingCapAction,
        { capAmount: 5 },
        { organizationId: crypto.randomUUID(), db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})
