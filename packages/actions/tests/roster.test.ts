/**
 * `roster.import` (ROST-9): enqueues rather than working inline — the same
 * "action enqueues, the worker does the work" shape `discordServers.scaffold`
 * already holds itself to (`tests/discord-servers.test.ts`). Dispatching it
 * creates exactly one job row, carrying the course id and the roster's own
 * CSV text, and reaches no Discord state or person at all — this package
 * holds no Discord client and no CSV parser to reach either with.
 */

import { courses, jobs, projects, schema, type Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { importRosterAction } from '../src/actions/roster.js'
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
      filePrefix: 'tc',
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

function allJobRows(db: Database): jobs.Job[] {
  return db.select().from(schema.jobs).all()
}

const CSV =
  'First,Last,Email,Discord,GitHub\nAda,Lovelace,ada@example.edu,adalovelace,adal'

describe('roster.import (ROST-9)', () => {
  it('enqueues a roster.import job naming the course and carrying the roster text, without doing any work inline', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)
    const before = allJobRows(testDb.db).length

    const result = await dispatch(
      importRosterAction,
      { courseId, csvText: CSV },
      { organizationId, db: testDb.db }
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
    expect(JSON.parse(created?.payload ?? '{}')).toEqual({
      courseId,
      csvText: CSV,
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

    await expect(
      dispatch(
        importRosterAction,
        { courseId, csvText: CSV },
        { organizationId: orgB, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(allJobRows(testDb.db)).toHaveLength(0)
  })

  it('refuses an empty upload outright, before it ever reaches the policy', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithBoundServer(testDb.db)
    const courseId = seedCourse(organizationId, testDb.db)

    await expect(
      dispatch(
        importRosterAction,
        { courseId, csvText: '' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionInputError)

    expect(allJobRows(testDb.db)).toHaveLength(0)
  })
})
