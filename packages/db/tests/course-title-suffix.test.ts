/**
 * PORT-5: `nextAvailableCourseTitle` — the title an imported course is
 * actually given, so importing a course beside the one it was exported from
 * produces a list a person can still read.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { courses, organizations, projects } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization with two projects, synthetic data only (QA-3). */
function seed(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    testDatabase.db
  )
  const projectId = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    testDatabase.db
  ).id
  const otherProjectId = projects.createProject(
    organizationId,
    { name: 'Spring 2027' },
    testDatabase.db
  ).id
  return { organizationId, projectId, otherProjectId }
}

/** Creates a disabled course with `title`, which is all these tests need of one. */
function addCourse(
  testDatabase: TestDatabase,
  organizationId: string,
  projectId: string,
  title: string
): void {
  const result = courses.createCourse(
    organizationId,
    {
      projectId,
      title,
      enabled: false,
      adminsRole: `admins-${randomUUID()}`,
      studentsRole: `students-${randomUUID()}`,
      categories: [],
    },
    testDatabase.db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
}

describe('nextAvailableCourseTitle', () => {
  it('leaves a free title alone', () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seed(testDb)
    expect(
      courses.nextAvailableCourseTitle(
        organizationId,
        projectId,
        'Intro to CS',
        testDb.db
      )
    ).toBe('Intro to CS')
  })

  it('numbers the copies from 2 upward', () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seed(testDb)
    addCourse(testDb, organizationId, projectId, 'Intro to CS')
    expect(
      courses.nextAvailableCourseTitle(
        organizationId,
        projectId,
        'Intro to CS',
        testDb.db
      )
    ).toBe('Intro to CS 2')

    addCourse(testDb, organizationId, projectId, 'Intro to CS 2')
    expect(
      courses.nextAvailableCourseTitle(
        organizationId,
        projectId,
        'Intro to CS',
        testDb.db
      )
    ).toBe('Intro to CS 3')
  })

  it('fills a gap rather than counting past it', () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seed(testDb)
    // "Intro to CS 2" was deleted or renamed; the next import belongs in
    // that gap, not at 4.
    addCourse(testDb, organizationId, projectId, 'Intro to CS')
    addCourse(testDb, organizationId, projectId, 'Intro to CS 3')
    expect(
      courses.nextAvailableCourseTitle(
        organizationId,
        projectId,
        'Intro to CS',
        testDb.db
      )
    ).toBe('Intro to CS 2')
  })

  it('compares leniently but does not rewrite the title it was given', () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seed(testDb)
    addCourse(testDb, organizationId, projectId, 'Intro to CS')
    expect(
      courses.nextAvailableCourseTitle(
        organizationId,
        projectId,
        '  intro   to cs  ',
        testDb.db
      )
      // The *comparison* ignores case and spacing, so this counts as the
      // title already taken; the title handed back is still the caller's own,
      // only trimmed — matching leniently is not a licence to rewrite what
      // somebody typed.
    ).toBe('intro   to cs 2')
  })

  it('counts only the project being imported into', () => {
    testDb = createTestDatabase()
    const { organizationId, projectId, otherProjectId } = seed(testDb)
    addCourse(testDb, organizationId, otherProjectId, 'Intro to CS')
    expect(
      courses.nextAvailableCourseTitle(
        organizationId,
        projectId,
        'Intro to CS',
        testDb.db
      )
    ).toBe('Intro to CS')
  })

  it('counts only the caller organization (TEN-2)', () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seed(testDb)
    const otherOrg = randomUUID()
    organizations.createOrganization(
      otherOrg,
      { name: 'Other Org', isPersonal: false },
      testDb.db
    )
    // A course another organization happens to hold cannot push this one's
    // title along — `listCourses` is organization-scoped, and this reads
    // through it rather than around it.
    addCourse(testDb, organizationId, projectId, 'Intro to CS')
    expect(
      courses.nextAvailableCourseTitle(
        otherOrg,
        projectId,
        'Intro to CS',
        testDb.db
      )
    ).toBe('Intro to CS')
  })
})
