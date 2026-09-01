/**
 * COST-4's instructor read (`costLedger.organizationUsage`) — exercised
 * through `dispatch`, the same tenant-scoping proof every other read in
 * `reads.test.ts` gets: a caller cannot see another organization's usage
 * through this action either.
 */

import { costLedger, courses, organizations, people, usage } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { organizationUsageAction } from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { seedOrganizationWithProject } from './helpers/seed.js'
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
    expect(result.courses).toEqual([
      {
        courseId: course.id,
        courseTitle: 'Test Course',
        costMicros: 500,
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
})
