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

  // --- Finding 8 of the CORE-1 rework: `reserveUsageSlot` is atomic -------

  it('grants each request up to the limit, returning the count so far, and refuses once the limit is reached', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    expect(
      usage.reserveUsageSlot(
        orgA,
        courseA.id,
        personA.id,
        '2026-08-31',
        3,
        testDb.db
      )
    ).toEqual({ granted: true, count: 1 })
    expect(
      usage.reserveUsageSlot(
        orgA,
        courseA.id,
        personA.id,
        '2026-08-31',
        3,
        testDb.db
      )
    ).toEqual({ granted: true, count: 2 })
    expect(
      usage.reserveUsageSlot(
        orgA,
        courseA.id,
        personA.id,
        '2026-08-31',
        3,
        testDb.db
      )
    ).toEqual({ granted: true, count: 3 })
    // The fourth request would push the stored count past the limit — refused.
    expect(
      usage.reserveUsageSlot(
        orgA,
        courseA.id,
        personA.id,
        '2026-08-31',
        3,
        testDb.db
      )
    ).toEqual({ granted: false })
    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(3)
  })

  it('refuses the very first request of the day for a limit of 0', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    expect(
      usage.reserveUsageSlot(
        orgA,
        courseA.id,
        personA.id,
        '2026-08-31',
        0,
        testDb.db
      )
    ).toEqual({ granted: false })
    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, '2026-08-31', testDb.db)
    ).toBe(0)
  })

  it('grants every request, unconditionally, when `limit` is null', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    for (let i = 1; i <= 20; i++) {
      expect(
        usage.reserveUsageSlot(
          orgA,
          courseA.id,
          personA.id,
          '2026-08-31',
          null,
          testDb.db
        )
      ).toEqual({ granted: true, count: i })
    }
  })

  it('refuses a course belonging to another organization, returning `undefined`', () => {
    testDb = createTestDatabase()
    const { orgA, courseB, personA } = seedTwoOrganizations(testDb)

    expect(
      usage.reserveUsageSlot(
        orgA,
        courseB.id,
        personA.id,
        '2026-08-31',
        3,
        testDb.db
      )
    ).toBeUndefined()
  })

  it('refuses a person belonging to another organization, returning `undefined`', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personB } = seedTwoOrganizations(testDb)

    expect(
      usage.reserveUsageSlot(
        orgA,
        courseA.id,
        personB.id,
        '2026-08-31',
        3,
        testDb.db
      )
    ).toBeUndefined()
  })

  // The regression finding 8 exists to close, reproduced at the level it
  // actually occurs: two callers racing an `await` *between* a check and a
  // write can both read the same "one slot left" count, both pass the
  // check, and both write — landing the stored count one *past* `limit`
  // even though the check itself never let a request through improperly.
  // `getUsageCount` followed by `incrementUsage` is exactly the two-step
  // shape `answerQuestion` used to use, with the model call's own `await`
  // sitting between them; that gap is what `reserveUsageSlot` closes by
  // exposing the check and the write as a *single* call with no `await`
  // inside it — there is no separate "read" step for a caller to put
  // anything between and its own increment, the same way there was here.
  // (The concurrent case for `reserveUsageSlot` itself, and for
  // `answerQuestion` built on it, is covered in `packages/core`'s
  // `answer.test.ts`, driving two real `answerQuestion` calls around a
  // model client under this test's control — the shape the brief asks for,
  // and the one that actually exercises the `await` this bug lived around.)
  it('the two-step check-then-increment `answerQuestion` used to do is over-granted by two callers racing an `await` between them', async () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    const day = '2026-08-31'
    const limit = 3
    // One slot left before the limit is reached.
    for (let i = 0; i < limit - 1; i++) {
      usage.incrementUsage(orgA, courseA.id, personA.id, day, testDb.db)
    }

    // Two "requests" interleave around a network call (`await`), each doing
    // the old two-step check-then-increment. `Promise.all` below invokes
    // both synchronously up to their first `await` before either resumes —
    // the same interleaving an `await model.ask(...)` between a read and a
    // write produces for two real concurrent callers — so both read the
    // same `usedBefore` (one slot left) before either has written.
    async function racingTwoStepIncrement(): Promise<void> {
      const usedBefore = usage.getUsageCount(
        orgA,
        courseA.id,
        personA.id,
        day,
        testDb.db
      )
      await Promise.resolve() // the `await model.ask(...)` this reproduces
      if (usedBefore < limit) {
        usage.incrementUsage(orgA, courseA.id, personA.id, day, testDb.db)
      }
    }

    await Promise.all([racingTwoStepIncrement(), racingTwoStepIncrement()])
    // Both calls saw one slot left and both took it: the stored count is one
    // past `limit`, even though the check itself never let a request through
    // improperly — this is the bug finding 8 describes, and the two-step
    // shape this file no longer exposes to `answerQuestion`.
    expect(
      usage.getUsageCount(orgA, courseA.id, personA.id, day, testDb.db)
    ).toBe(limit + 1)
  })
})

describe('listUsageNearLimit (COST-4)', () => {
  it('reports a person at or above the threshold ratio, and not one below it, scoped to the requesting organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA, personA } = seedTwoOrganizations(testDb)
    const day = '2026-08-31'
    // courseA.maxRequestsPerDay is 3 (seedTwoOrganizations) — two of three
    // is the default 80% threshold's own boundary (2/3 ≈ 0.667 < 0.8; use
    // three of three to be unambiguously over it).
    usage.incrementUsage(orgA, courseA.id, personA.id, day, testDb.db)
    usage.incrementUsage(orgA, courseA.id, personA.id, day, testDb.db)
    usage.incrementUsage(orgA, courseA.id, personA.id, day, testDb.db)

    const nearLimit = usage.listUsageNearLimit(orgA, day, testDb.db)

    expect(nearLimit).toEqual([
      {
        courseId: courseA.id,
        courseTitle: 'Web Design',
        personId: personA.id,
        personDisplayName: 'A',
        count: 3,
        maxRequestsPerDay: 3,
      },
    ])
    // Scoped: the same query against the other organization sees nothing,
    // even though nothing about courseA/personA's own ids changed.
    expect(usage.listUsageNearLimit(orgB, day, testDb.db)).toEqual([])
  })

  it('does not report a person below the threshold ratio', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    const day = '2026-08-31'
    // One of three is well under 80%.
    usage.incrementUsage(orgA, courseA.id, personA.id, day, testDb.db)

    expect(usage.listUsageNearLimit(orgA, day, testDb.db)).toEqual([])
  })

  it('never reports a course with no configured limit — there is nothing to be "near"', () => {
    testDb = createTestDatabase()
    const { orgA, personA } = seedTwoOrganizations(testDb)
    const project = projects.createProject(
      orgA,
      { name: 'Unlimited Term' },
      testDb.db
    )
    const unlimited = courses.createCourse(
      orgA,
      courseInput(project.id, {
        maxRequestsPerDay: null,
        adminsRole: 'admins-unlimited',
        studentsRole: 'students-unlimited',
      }),
      testDb.db
    )
    if (!unlimited.ok) throw new Error('seed course creation failed')
    usage.incrementUsage(
      orgA,
      unlimited.course.id,
      personA.id,
      '2026-08-31',
      testDb.db
    )

    expect(usage.listUsageNearLimit(orgA, '2026-08-31', testDb.db)).toEqual([])
  })
})
