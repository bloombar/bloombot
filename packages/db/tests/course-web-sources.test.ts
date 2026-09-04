import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  courses,
  courseWebSources,
  organizations,
  projects,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one course, synthetic data only (QA-3) — mirrors `course-attachments.test.ts`'s own fixture. */
function seedTwoOrganizationsWithCourses(testDatabase: TestDatabase) {
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
      filePrefix: 'wd',
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
      filePrefix: 'ds',
      enabled: true,
      adminsRole: 'admins-ds',
      studentsRole: 'students-ds',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseA.ok || !courseB.ok) throw new Error('seed course save failed')
  return { orgA, orgB, courseA: courseA.course, courseB: courseB.course }
}

describe('course-web-sources repo (FILE-6, MDL-9)', () => {
  it('adds a website to a course and lists it back', () => {
    testDb = createTestDatabase()
    const { orgA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    const created = courseWebSources.addWebSource(
      orgA,
      { courseId: courseA.id, domain: 'example.edu' },
      testDb.db
    )
    expect(created.domain).toBe('example.edu')
    expect(created.courseId).toBe(courseA.id)

    const listed = courseWebSources.listWebSourcesForCourse(
      orgA,
      courseA.id,
      testDb.db
    )
    expect(listed.map((s) => s.domain)).toEqual(['example.edu'])
  })

  it('lists only a courses own websites', () => {
    testDb = createTestDatabase()
    const { orgA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    courseWebSources.addWebSource(
      orgA,
      { courseId: courseA.id, domain: 'a.example.edu' },
      testDb.db
    )
    courseWebSources.addWebSource(
      orgA,
      { courseId: courseA.id, domain: 'b.example.edu' },
      testDb.db
    )

    const listed = courseWebSources.listWebSourcesForCourse(
      orgA,
      courseA.id,
      testDb.db
    )
    expect(listed.map((s) => s.domain).sort()).toEqual([
      'a.example.edu',
      'b.example.edu',
    ])
  })

  // `course_web_sources_course_domain_unique` (schema.ts) — a course cannot
  // name the same domain twice; the repo lets the constraint refuse it
  // rather than checking first (the same D-12 discipline
  // `course-attachments.ts`'s own module comment gives).
  it('refuses a duplicate domain on the same course with the databases own unique constraint', () => {
    testDb = createTestDatabase()
    const { orgA, courseA } = seedTwoOrganizationsWithCourses(testDb)

    courseWebSources.addWebSource(
      orgA,
      { courseId: courseA.id, domain: 'example.edu' },
      testDb.db
    )

    expect(() =>
      courseWebSources.addWebSource(
        orgA,
        { courseId: courseA.id, domain: 'example.edu' },
        testDb.db
      )
    ).toThrow(/UNIQUE/)
  })

  it('the same domain may be added to two different courses', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA, courseB } =
      seedTwoOrganizationsWithCourses(testDb)

    courseWebSources.addWebSource(
      orgA,
      { courseId: courseA.id, domain: 'example.edu' },
      testDb.db
    )
    courseWebSources.addWebSource(
      orgB,
      { courseId: courseB.id, domain: 'example.edu' },
      testDb.db
    )

    expect(
      courseWebSources
        .listWebSourcesForCourse(orgA, courseA.id, testDb.db)
        .map((s) => s.domain)
    ).toEqual(['example.edu'])
    expect(
      courseWebSources
        .listWebSourcesForCourse(orgB, courseB.id, testDb.db)
        .map((s) => s.domain)
    ).toEqual(['example.edu'])
  })

  // TEN-5 — the same "identical not-found" every other scoped repo in this
  // package holds itself to (`course-attachments.test.ts`'s own identical
  // test).
  it("TEN-5: another organization's website is not readable, listable or deletable — identical not-found", () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA } = seedTwoOrganizationsWithCourses(testDb)

    const created = courseWebSources.addWebSource(
      orgA,
      { courseId: courseA.id, domain: 'private.example.edu' },
      testDb.db
    )

    // Not readable from orgB.
    expect(
      courseWebSources.getWebSource(orgB, created.id, testDb.db)
    ).toBeUndefined()

    // Not listable from orgB, even scoped to orgA's own course id.
    expect(
      courseWebSources.listWebSourcesForCourse(orgB, courseA.id, testDb.db)
    ).toEqual([])

    // Not deletable from orgB — the row survives, untouched.
    expect(courseWebSources.deleteWebSource(orgB, created.id, testDb.db)).toBe(
      false
    )
    expect(
      courseWebSources.getWebSource(orgA, created.id, testDb.db)
    ).toBeDefined()

    // orgA can delete its own.
    expect(courseWebSources.deleteWebSource(orgA, created.id, testDb.db)).toBe(
      true
    )
    expect(
      courseWebSources.getWebSource(orgA, created.id, testDb.db)
    ).toBeUndefined()
  })
})
