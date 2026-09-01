import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  courses,
  organizations,
  people,
  projects,
  schema,
  usage,
} from '@bloombot/db'
import type { courses as coursesRepo } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** A minimal, valid course input, overridable per test. */
function courseInput(
  projectId: string,
  overrides: Partial<coursesRepo.NewCourse> = {}
): coursesRepo.NewCourse {
  return {
    projectId,
    title: 'Web Design',
    filePrefix: 'wd',
    enabled: true,
    adminsRole: 'admins-wd',
    studentsRole: 'students-wd',
    categories: [],
    ...overrides,
  }
}

/** Seeds two organizations, each with one project, one course and one person, synthetic data only (QA-3). */
function seedTwoOrganizations(testDatabase: TestDatabase) {
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
    courseInput(projectA.id, { maxRequestsPerDay: 3 }),
    testDatabase.db
  )
  const courseB = courses.createCourse(
    orgB,
    courseInput(projectB.id, { maxRequestsPerDay: 3 }),
    testDatabase.db
  )
  if (!courseA.ok || !courseB.ok) throw new Error('seed course creation failed')

  const personA = people.createPerson(
    orgA,
    { displayName: 'A' },
    testDatabase.db
  )
  const personB = people.createPerson(
    orgB,
    { displayName: 'B' },
    testDatabase.db
  )

  return {
    orgA,
    orgB,
    courseA: courseA.course,
    courseB: courseB.course,
    personA,
    personB,
  }
}

describe('usage repo', () => {
  // --- Tenant scoping (TEN-2/TEN-5) ---------------------------------------

  it('refuses to increment usage for a course belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, courseB, personA } = seedTwoOrganizations(testDb)

    const result = usage.incrementUsage(
      orgA,
      courseB.id,
      personA.id,
      '2026-08-31',
      testDb.db
    )

    expect(result).toBeUndefined()
    expect(
      usage.getUsageCount(orgA, courseB.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(0)
  })

  it('refuses to increment usage for a person belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personB } = seedTwoOrganizations(testDb)

    const result = usage.incrementUsage(
      orgA,
      courseA.id,
      personB.id,
      '2026-08-31',
      testDb.db
    )

    expect(result).toBeUndefined()
  })

  it('reads only the requesting organization`s own count', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA, personA } = seedTwoOrganizations(testDb)

    usage.incrementUsage(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)

    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(1)
    // Same course/person ids read through the wrong organization see nothing.
    expect(
      usage.getUsageCount(orgB, courseA.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(0)
  })

  // --- CONV-3: the day boundary is decided by the caller, not the clock --

  it('counts a person`s requests per course per day, starting at zero', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(0)

    usage.incrementUsage(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    usage.incrementUsage(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)

    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(2)
  })

  // BOT-11's regression, one layer down: the same person, the same course,
  // requests that would cross midnight in wall-clock time — but nothing
  // here reads a clock. Two different day strings passed by the caller are
  // what keep the counts separate, proving the day boundary is a property
  // of the caller's input, not of when the request happens to run.
  it('the same person crossing midnight gets a fresh count, decided by the caller`s day string', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    usage.incrementUsage(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    usage.incrementUsage(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    usage.incrementUsage(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    // A third request on 2026-08-31 would exhaust `maxRequestsPerDay: 3` —
    // instead, the caller passes the next day's string for this one.
    usage.incrementUsage(orgA, courseA.id, personA.id, '2026-09-01', testDb.db)

    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(3)
    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, '2026-09-01', testDb.db)
    ).toBe(1)
    expect(
      usage.hasExhaustedDailyLimit(
        orgA,
        courseA.id,
        personA.id,
        '2026-08-31',
        testDb.db
      )
    ).toBe(true)
    expect(
      usage.hasExhaustedDailyLimit(
        orgA,
        courseA.id,
        personA.id,
        '2026-09-01',
        testDb.db
      )
    ).toBe(false)
  })

  it('a course with no configured limit is never reported exhausted', () => {
    testDb = createTestDatabase()
    const { orgA, personA } = seedTwoOrganizations(testDb)
    const project = projects.createProject(
      orgA,
      { name: 'Spring 2027' },
      testDb.db
    )
    const unlimited = courses.createCourse(
      orgA,
      courseInput(project.id, {
        adminsRole: 'admins-unlimited',
        studentsRole: 'students-unlimited',
        maxRequestsPerDay: null,
      }),
      testDb.db
    )
    if (!unlimited.ok) throw new Error('seed course creation failed')

    for (let i = 0; i < 50; i++) {
      usage.incrementUsage(
        orgA,
        unlimited.course.id,
        personA.id,
        '2026-08-31',
        testDb.db
      )
    }

    expect(
      usage.hasExhaustedDailyLimit(
        orgA,
        unlimited.course.id,
        personA.id,
        '2026-08-31',
        testDb.db
      )
    ).toBe(false)
  })

  // Finding 4 of the CONV-1 rework: `hasExhaustedDailyLimit` used to return
  // `false` — "not exhausted" — for a course that does not belong to
  // `organizationId` at all, indistinguishable from "no limit configured".
  // An action layer calling this with a course from another organization
  // would see "not exhausted" and let the request proceed, while the paired
  // `incrementUsage` already refuses the same input with `undefined` and
  // counts nothing — an uncapped, unrecorded conversation. Tri-state closes
  // that: `undefined` here, distinct from both `false` (no limit
  // configured, covered above) and a real `true`/`false` exhaustion result
  // (covered by the midnight-boundary test above).
  it('reports `undefined`, not `false`, for a course belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, courseB, personA } = seedTwoOrganizations(testDb)

    expect(
      usage.hasExhaustedDailyLimit(
        orgA,
        courseB.id, // belongs to orgB
        personA.id,
        '2026-08-31',
        testDb.db
      )
    ).toBeUndefined()
  })

  it('reports `undefined` for a course id that does not exist at all', () => {
    testDb = createTestDatabase()
    const { orgA, personA } = seedTwoOrganizations(testDb)

    expect(
      usage.hasExhaustedDailyLimit(
        orgA,
        randomUUID(),
        personA.id,
        '2026-08-31',
        testDb.db
      )
    ).toBeUndefined()
  })

  // --- Finding 5: `day` must be `YYYY-MM-DD`, both in the repo and in SQL -

  it('refuses a malformed `day` before it ever reaches SQL', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    for (const badDay of [
      '2026-8-31',
      '8/31/2026',
      '2026-08-31T00:00:00',
      '',
    ]) {
      expect(() =>
        usage.incrementUsage(orgA, courseA.id, personA.id, badDay, testDb.db)
      ).toThrow(/Invalid day/)
      expect(() =>
        usage.getUsageCount(orgA, courseA.id, personA.id, badDay, testDb.db)
      ).toThrow(/Invalid day/)
    }
  })

  // Belt-and-suspenders on top of the repo's own regex: a writer that
  // reaches `usage_counters` directly (skipping `repos/usage.ts` entirely)
  // is stopped by `usage_counters_day_check` (`schema.ts`) instead.
  it('refuses a malformed `day` written directly, by CHECK constraint', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    expect(() =>
      testDb.db
        .insert(schema.usageCounters)
        .values({
          organizationId: orgA,
          courseId: courseA.id,
          personId: personA.id,
          day: '2026-8-31',
          count: 1,
        })
        .run()
    ).toThrow(/CHECK constraint failed/)
  })
})
