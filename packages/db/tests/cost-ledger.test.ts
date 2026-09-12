import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  costLedger,
  courses,
  organizations,
  people,
  projects,
} from '@bloombot/db'
import type { courses as coursesRepo } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function courseInput(
  projectId: string,
  overrides: Partial<coursesRepo.NewCourse> = {}
): coursesRepo.NewCourse {
  return {
    projectId,
    title: 'Web Design',
    enabled: true,
    adminsRole: 'admins-wd',
    studentsRole: 'students-wd',
    categories: [],
    ...overrides,
  }
}

/** Seeds two organizations, each with one project, one course and one person (QA-3: synthetic data only). */
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
    courseInput(projectA.id),
    testDatabase.db
  )
  const courseB = courses.createCourse(
    orgB,
    courseInput(projectB.id),
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

/** A minimal, valid ledger entry, overridable per test. */
function ledgerEntry(
  courseId: string,
  personId: string,
  overrides: Partial<costLedger.NewCostLedgerEntry> = {}
): costLedger.NewCostLedgerEntry {
  return {
    courseId,
    personId,
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    costMicros: 1_000,
    measurement: 'measured',
    surface: 'discord',
    ...overrides,
  }
}

describe('cost-ledger repo', () => {
  // --- COST-1/COST-2: attribution ------------------------------------------

  it('records a call attributed to organization, course and person', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const row = costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id),
      testDb.db
    )

    expect(row).toBeDefined()
    expect(row?.organizationId).toBe(orgA)
    expect(row?.courseId).toBe(courseA.id)
    expect(row?.personId).toBe(personA.id)
    expect(row?.model).toBe('gpt-4o')
    expect(row?.inputTokens).toBe(100)
    expect(row?.outputTokens).toBe(50)
    expect(row?.costMicros).toBe(1_000)
    expect(row?.measurement).toBe('measured')
  })

  it('refuses to record a call for a course belonging to another organization — an unattributed row cannot be written', () => {
    testDb = createTestDatabase()
    const { orgA, courseB, personA } = seedTwoOrganizations(testDb)

    const row = costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseB.id, personA.id),
      testDb.db
    )

    expect(row).toBeUndefined()
    expect(costLedger.getOrganizationSpentMicros(orgA, testDb.db)).toBe(0)
  })

  it('refuses to record a call for a person belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personB } = seedTwoOrganizations(testDb)

    const row = costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personB.id),
      testDb.db
    )

    expect(row).toBeUndefined()
  })

  it('cannot construct a ledger row with a missing organization, course or person id — the columns are NOT NULL', () => {
    testDb = createTestDatabase()
    const { courseA, personA } = seedTwoOrganizations(testDb)

    // A future direct writer skipping this file entirely still cannot
    // insert a null-attributed row — the schema itself refuses it
    // (`cost_ledger_entries`'s `NOT NULL` foreign keys, `schema.ts`). Uses
    // the raw `better-sqlite3` handle, the same device `client.ts`'s own
    // `closeDatabase` reaches for, to prove the constraint holds even for a
    // writer that bypasses this file's own TypeScript surface entirely.
    expect(() =>
      testDb.db.$client
        .prepare(
          `insert into cost_ledger_entries (id, organization_id, course_id, person_id, model, cost_micros, measurement, surface, created_at) values (?, null, ?, ?, 'gpt-4o', 0, 'measured', 'discord', 0)`
        )
        .run('x', courseA.id, personA.id)
    ).toThrow()
  })

  // --- COST-3: the spending cap ---------------------------------------------

  it('has not reached a cap that was never configured', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    expect(costLedger.hasReachedSpendingCap(orgA, testDb.db)).toBe(false)
  })

  it('reports undefined for an organization that does not exist', () => {
    testDb = createTestDatabase()
    seedTwoOrganizations(testDb)

    expect(
      costLedger.hasReachedSpendingCap(randomUUID(), testDb.db)
    ).toBeUndefined()
  })

  it('reports reaching the cap once recorded spend meets or exceeds it', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    organizations.setSpendingCap(orgA, 1_500, testDb.db)

    expect(costLedger.hasReachedSpendingCap(orgA, testDb.db)).toBe(false)

    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, { costMicros: 1_500 }),
      testDb.db
    )

    expect(costLedger.hasReachedSpendingCap(orgA, testDb.db)).toBe(true)
  })

  // --- COST-4: reads ----------------------------------------------------

  it('summarizes an organization`s own usage by course, without another organization`s courses', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA, courseB, personA, personB } =
      seedTwoOrganizations(testDb)
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, { costMicros: 700 }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgB,
      ledgerEntry(courseB.id, personB.id, { costMicros: 999 }),
      testDb.db
    )

    const summary = costLedger.getOrganizationUsageSummary(orgA, testDb.db)

    expect(summary.organizationId).toBe(orgA)
    expect(summary.totalCostMicros).toBe(700)
    // Both rows above were recorded `measurement: 'measured'` (`ledgerEntry`'s
    // own default) — nothing here is an estimate.
    expect(summary.totalEstimatedCostMicros).toBe(0)
    expect(summary.courses).toEqual([
      {
        courseId: courseA.id,
        courseTitle: 'Web Design',
        costMicros: 700,
        estimatedCostMicros: 0,
        callCount: 1,
        bySurface: [
          {
            surface: 'discord',
            costMicros: 700,
            estimatedCostMicros: 0,
            callCount: 1,
          },
        ],
      },
    ])
    expect(summary.bySurface).toEqual([
      {
        surface: 'discord',
        costMicros: 700,
        estimatedCostMicros: 0,
        callCount: 1,
      },
    ])
  })

  it('splits a course`s own total into what is measured and what is estimated', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, {
        costMicros: 700,
        measurement: 'measured',
      }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, {
        costMicros: 300,
        measurement: 'estimated',
      }),
      testDb.db
    )

    const summary = costLedger.getOrganizationUsageSummary(orgA, testDb.db)

    // COST-6 — a total made partly of estimates must say so, not present
    // itself identically to a total that is entirely measured.
    expect(summary.totalCostMicros).toBe(1_000)
    expect(summary.totalEstimatedCostMicros).toBe(300)
    expect(summary.courses[0]?.costMicros).toBe(1_000)
    expect(summary.courses[0]?.estimatedCostMicros).toBe(300)
    // Both rows were recorded on the same surface (`ledgerEntry`'s own
    // `'discord'` default) — the breakdown must still reconcile with the
    // course's own total rather than carry two entries for one surface.
    expect(summary.courses[0]?.bySurface).toEqual([
      {
        surface: 'discord',
        costMicros: 1_000,
        estimatedCostMicros: 300,
        callCount: 2,
      },
    ])
  })

  it('splits a course`s own total by surface, reconciling with the un-split totals', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, {
        costMicros: 100,
        measurement: 'measured',
        surface: 'discord',
      }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, {
        costMicros: 200,
        measurement: 'estimated',
        surface: 'web',
      }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, {
        costMicros: 300,
        measurement: 'measured',
        surface: 'mcp',
      }),
      testDb.db
    )

    const summary = costLedger.getOrganizationUsageSummary(orgA, testDb.db)
    const course = summary.courses[0]
    const bySurface = new Map(
      course?.bySurface.map((entry) => [entry.surface, entry])
    )

    expect(bySurface.get('discord')).toEqual({
      surface: 'discord',
      costMicros: 100,
      estimatedCostMicros: 0,
      callCount: 1,
    })
    expect(bySurface.get('web')).toEqual({
      surface: 'web',
      costMicros: 200,
      estimatedCostMicros: 200,
      callCount: 1,
    })
    expect(bySurface.get('mcp')).toEqual({
      surface: 'mcp',
      costMicros: 300,
      estimatedCostMicros: 0,
      callCount: 1,
    })
    // A course that has never been asked through a surface does not carry a
    // zero entry for it — exactly the three surfaces used above, no more.
    expect(bySurface.size).toBe(3)

    // The breakdown reconciles with the un-split totals — it adds detail,
    // it does not replace them.
    expect(course?.costMicros).toBe(600)
    expect(course?.estimatedCostMicros).toBe(200)
    expect(course?.callCount).toBe(3)
    expect(summary.totalCostMicros).toBe(600)
    expect(summary.totalEstimatedCostMicros).toBe(200)
    const summaryBySurface = new Map(
      summary.bySurface.map((entry) => [entry.surface, entry])
    )
    expect(summaryBySurface.get('discord')?.costMicros).toBe(100)
    expect(summaryBySurface.get('web')?.costMicros).toBe(200)
    expect(summaryBySurface.get('mcp')?.costMicros).toBe(300)
  })

  it('reports totals per organization, and nothing about a conversation', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA, courseB, personA, personB } =
      seedTwoOrganizations(testDb)
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, { costMicros: 500 }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgB,
      ledgerEntry(courseB.id, personB.id, { costMicros: 250 }),
      testDb.db
    )

    const totals = costLedger.listOrganizationTotals(testDb.db)
    const byId = new Map(totals.map((row) => [row.organizationId, row]))

    expect(byId.get(orgA)).toEqual({
      organizationId: orgA,
      organizationName: 'Org A',
      totalCostMicros: 500,
      estimatedCostMicros: 0,
      callCount: 1,
      bySurface: [
        {
          surface: 'discord',
          costMicros: 500,
          estimatedCostMicros: 0,
          callCount: 1,
        },
      ],
    })
    expect(byId.get(orgB)).toEqual({
      organizationId: orgB,
      organizationName: 'Org B',
      totalCostMicros: 250,
      estimatedCostMicros: 0,
      callCount: 1,
      bySurface: [
        {
          surface: 'discord',
          costMicros: 250,
          estimatedCostMicros: 0,
          callCount: 1,
        },
      ],
    })
    // COST-4/ADMIN-4 — every field here is a name or a number, or the same
    // per-surface breakdown of those numbers; there is no key this response
    // could carry a transcript's content under.
    for (const row of totals) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'bySurface',
          'callCount',
          'estimatedCostMicros',
          'organizationId',
          'organizationName',
          'totalCostMicros',
        ].sort()
      )
    }
  })

  it('splits an organization`s own total by surface, reconciling with the un-split totals', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, {
        costMicros: 100,
        surface: 'discord',
      }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, { costMicros: 200, surface: 'mcp' }),
      testDb.db
    )

    const totals = costLedger.listOrganizationTotals(testDb.db)
    const orgATotal = totals.find((row) => row.organizationId === orgA)
    const bySurface = new Map(
      orgATotal?.bySurface.map((entry) => [entry.surface, entry])
    )

    expect(orgATotal?.totalCostMicros).toBe(300)
    expect(orgATotal?.callCount).toBe(2)
    expect(bySurface.get('discord')?.costMicros).toBe(100)
    expect(bySurface.get('mcp')?.costMicros).toBe(200)
    expect(bySurface.size).toBe(2)
  })

  // COST-7 rework — `seedTwoOrganizations` puts exactly one course in each
  // organization, so nothing above ever exercises the organization-level
  // `bySurface` accumulation (`getOrganizationUsageSummary`'s own
  // `organizationBySurface` map) with two *different* courses in the same
  // organization contributing to the same surface. A regression from `+=`
  // to `push` on that map would silently emit two separate `discord`
  // entries for this one organization instead of summing them into one —
  // every test above would still pass, since each only ever has a single
  // course per organization.
  it('sums two courses` own contributions to the same surface into one organization-level entry, not two', () => {
    testDb = createTestDatabase()
    const { orgA, personA } = seedTwoOrganizations(testDb)
    const projectA = projects.createProject(
      orgA,
      { name: 'Second Project' },
      testDb.db
    )
    const secondCourseResult = courses.createCourse(
      orgA,
      courseInput(projectA.id, {
        title: 'Second Course',
        adminsRole: 'admins-second',
        studentsRole: 'students-second',
      }),
      testDb.db
    )
    if (!secondCourseResult.ok) throw new Error('seed course creation failed')
    const secondCourse = secondCourseResult.course

    // `courseA` — resolved from the seed above via a fresh
    // `getOrganizationUsageSummary` read below — and `secondCourse` are two
    // distinct courses in `orgA`, each with their own `discord` entry.
    const firstSummaryBefore = costLedger.getOrganizationUsageSummary(
      orgA,
      testDb.db
    )
    const courseA = firstSummaryBefore.courses[0]
    if (!courseA) throw new Error('expected the seeded course to be present')

    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.courseId, personA.id, {
        costMicros: 100,
        surface: 'discord',
      }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(secondCourse.id, personA.id, {
        costMicros: 400,
        surface: 'discord',
      }),
      testDb.db
    )

    const summary = costLedger.getOrganizationUsageSummary(orgA, testDb.db)
    const bySurface = new Map(
      summary.bySurface.map((entry) => [entry.surface, entry])
    )

    // One `discord` entry at the organization level, summing both courses'
    // own contributions — not two entries, one per course.
    expect(bySurface.size).toBe(1)
    expect(bySurface.get('discord')).toEqual({
      surface: 'discord',
      costMicros: 500,
      estimatedCostMicros: 0,
      callCount: 2,
    })
    expect(summary.totalCostMicros).toBe(500)
  })

  // COST-7 rework — both grouped queries build `bySurface` from a SQL
  // `GROUP BY`, whose own row order SQLite makes no guarantee about.
  // Recorded in an order that would defeat an alphabetical (or incidental
  // insertion-order) sort — `mcp` before `discord` before `web` — so this
  // fails unless `bySurface` is actually sorted to
  // `COST_LEDGER_SURFACES`'s own declaration order (`discord`, `web`,
  // `mcp`, `unknown`) rather than left as whatever the query happened to
  // return.
  it('orders `bySurface` deterministically — the SURFACES declaration order, `unknown` last — regardless of insertion order', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, { costMicros: 1, surface: 'mcp' }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, {
        costMicros: 1,
        surface: 'discord',
      }),
      testDb.db
    )
    costLedger.recordCostLedgerEntry(
      orgA,
      ledgerEntry(courseA.id, personA.id, { costMicros: 1, surface: 'web' }),
      testDb.db
    )

    const summary = costLedger.getOrganizationUsageSummary(orgA, testDb.db)
    expect(summary.bySurface.map((entry) => entry.surface)).toEqual([
      'discord',
      'web',
      'mcp',
    ])
    expect(summary.courses[0]?.bySurface.map((entry) => entry.surface)).toEqual(
      ['discord', 'web', 'mcp']
    )

    const totals = costLedger.listOrganizationTotals(testDb.db)
    const orgATotal = totals.find((row) => row.organizationId === orgA)
    expect(orgATotal?.bySurface.map((entry) => entry.surface)).toEqual([
      'discord',
      'web',
      'mcp',
    ])
  })
})
