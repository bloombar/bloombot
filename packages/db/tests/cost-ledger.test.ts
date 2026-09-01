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
    filePrefix: 'wd',
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
          `insert into cost_ledger_entries (id, organization_id, course_id, person_id, model, cost_micros, measurement, created_at) values (?, null, ?, ?, 'gpt-4o', 0, 'measured', 0)`
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
    expect(summary.courses).toEqual([
      {
        courseId: courseA.id,
        courseTitle: 'Web Design',
        costMicros: 700,
        callCount: 1,
      },
    ])
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
      callCount: 1,
    })
    expect(byId.get(orgB)).toEqual({
      organizationId: orgB,
      organizationName: 'Org B',
      totalCostMicros: 250,
      callCount: 1,
    })
    // COST-4/ADMIN-4 — every field here is a name or a number; there is no
    // key this response could carry a transcript's content under.
    for (const row of totals) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'callCount',
          'organizationId',
          'organizationName',
          'totalCostMicros',
        ].sort()
      )
    }
  })
})
