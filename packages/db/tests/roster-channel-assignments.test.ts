/**
 * `roster-channel-assignments` repo (ROST-17) — each test below fails
 * without this slice's code: before it, `@bloombot/db` exported no
 * `rosterChannelAssignments`, and nothing recorded which Discord channel a
 * roster import created for a person.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  courses,
  organizations,
  people,
  projects,
  rosterChannelAssignments,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one course and one person — synthetic data only (QA-3), the same shape `course-web-sources.test.ts`'s own fixture uses. */
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
    {
      projectId: projectA.id,
      title: 'Web Design',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    testDatabase.db
  )
  const courseB = courses.createCourse(
    orgB,
    {
      projectId: projectB.id,
      title: 'Data Structures',
      enabled: true,
      adminsRole: 'admins-ds',
      studentsRole: 'students-ds',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseA.ok || !courseB.ok) throw new Error('seed course save failed')
  const personA = people.createPerson(orgA, {}, testDatabase.db)
  const personB = people.createPerson(orgB, {}, testDatabase.db)
  return {
    orgA,
    orgB,
    courseA: courseA.course,
    courseB: courseB.course,
    personA,
    personB,
  }
}

describe('roster-channel-assignments repo (ROST-17)', () => {
  it('records a channel for a person and reads it back', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const recorded = rosterChannelAssignments.recordChannelAssignment(
      orgA,
      {
        courseId: courseA.id,
        personId: personA.id,
        discordChannelId: 'chan-1',
      },
      testDb.db
    )
    expect(recorded).toMatchObject({ discordChannelId: 'chan-1' })

    const found = rosterChannelAssignments.getChannelAssignmentForPerson(
      orgA,
      courseA.id,
      personA.id,
      testDb.db
    )
    expect(found?.discordChannelId).toBe('chan-1')
  })

  it('is scoped by organization (TEN-5) — a lookup naming another organization finds nothing', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA, personA } = seedTwoOrganizations(testDb)

    rosterChannelAssignments.recordChannelAssignment(
      orgA,
      {
        courseId: courseA.id,
        personId: personA.id,
        discordChannelId: 'chan-1',
      },
      testDb.db
    )

    expect(
      rosterChannelAssignments.getChannelAssignmentForPerson(
        orgB,
        courseA.id,
        personA.id,
        testDb.db
      )
    ).toBeUndefined()
    expect(
      rosterChannelAssignments.getChannelAssignmentByDiscordChannelId(
        orgB,
        'chan-1',
        testDb.db
      )
    ).toBeUndefined()
  })

  it('a recreated channel replaces the same row rather than adding a second one', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    rosterChannelAssignments.recordChannelAssignment(
      orgA,
      {
        courseId: courseA.id,
        personId: personA.id,
        discordChannelId: 'chan-1',
      },
      testDb.db
    )
    // The remembered channel was deleted from the server and recreated
    // under a new id (ROST-17's own requirement 4) — recording again for
    // the same (course, person) updates the existing row.
    rosterChannelAssignments.recordChannelAssignment(
      orgA,
      {
        courseId: courseA.id,
        personId: personA.id,
        discordChannelId: 'chan-2',
      },
      testDb.db
    )

    const found = rosterChannelAssignments.getChannelAssignmentForPerson(
      orgA,
      courseA.id,
      personA.id,
      testDb.db
    )
    expect(found?.discordChannelId).toBe('chan-2')
    // The stale id is no longer remembered as anybody's — the row moved,
    // it was not duplicated.
    expect(
      rosterChannelAssignments.getChannelAssignmentByDiscordChannelId(
        orgA,
        'chan-1',
        testDb.db
      )
    ).toBeUndefined()
  })

  it('finds whichever person a channel is remembered as belonging to', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    rosterChannelAssignments.recordChannelAssignment(
      orgA,
      {
        courseId: courseA.id,
        personId: personA.id,
        discordChannelId: 'chan-1',
      },
      testDb.db
    )

    const found =
      rosterChannelAssignments.getChannelAssignmentByDiscordChannelId(
        orgA,
        'chan-1',
        testDb.db
      )
    expect(found?.personId).toBe(personA.id)
  })
})
