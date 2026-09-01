/**
 * MIG-2: a two-course legacy config produces one organization, one project,
 * and two courses with the right roles, categories and channels — read back
 * through `@bloombot/db`'s own repos, not by inspecting `importConfig`'s
 * return value, so this proves the rows actually landed rather than that
 * the importer's own report claims they did.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { courses, organizations, projects } from '@bloombot/db'

import { importConfig } from '../src/import-config.js'
import { twoCourseConfig } from './helpers/config-fixture.js'
import {
  createTestPlatformDatabase,
  type TestPlatformDatabase,
} from './helpers/platform-db.js'

let testDb: TestPlatformDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('importConfig (MIG-2)', () => {
  it('creates one organization, one project and two courses with their roles, categories and channels', () => {
    testDb = createTestPlatformDatabase()
    const config = twoCourseConfig('Knowledge Kitchen')

    const result = importConfig(config, testDb.db)

    expect(result.organizationCreated).toBe(true)
    expect(result.projectCreated).toBe(true)
    expect(result.courses).toHaveLength(2)
    expect(result.courses.every((outcome) => outcome.ok)).toBe(true)

    const organization = organizations.getOrganizationById(
      result.organizationId,
      testDb.db
    )
    expect(organization?.name).toBe('Knowledge Kitchen')

    const project = projects.getProject(
      result.organizationId,
      result.projectId,
      testDb.db
    )
    expect(project?.name).toBe('Knowledge Kitchen')

    const orgCourses = courses.listCourses(result.organizationId, testDb.db)
    expect(orgCourses).toHaveLength(2)

    const webDesign = orgCourses.find((course) => course.title === 'Web Design')
    expect(webDesign).toBeDefined()
    expect(webDesign?.adminsRole).toBe('admins-wd')
    expect(webDesign?.studentsRole).toBe('students-wd')
    expect(webDesign?.maxRequestsPerDay).toBe(20)

    const webDesignWithCategories = courses.getCourse(
      result.organizationId,
      webDesign!.id,
      testDb.db
    )
    expect(webDesignWithCategories?.categories.map((c) => c.name)).toEqual([
      'Web Design - GLOBAL',
      'Web Design - STUDENTS 01',
    ])
    const globalCategory = webDesignWithCategories?.categories[0]
    expect(globalCategory?.channels.map((c) => c.name)).toEqual([
      'admins',
      'general',
    ])
    expect(globalCategory?.channels[0]?.adminsOnly).toBe(true)
    expect(globalCategory?.channels[1]?.adminsOnly).toBe(false)

    const python = orgCourses.find((course) => course.title === 'Python')
    expect(python?.adminsRole).toBe('admins-py')
    expect(python?.maxRequestsPerDay).toBeNull()
  })

  it('a course refused by PROJ-3 is reported, not forced', () => {
    testDb = createTestPlatformDatabase()
    const config = twoCourseConfig('Colliding Server')
    // Both courses declare the same admin role — a PROJ-3 self-collision
    // `createCourse` refuses.
    config.server.courses[1]!.roles.admins =
      config.server.courses[0]!.roles.admins

    const result = importConfig(config, testDb.db)

    const secondOutcome = result.courses[1]
    expect(secondOutcome?.ok).toBe(false)

    const orgCourses = courses.listCourses(result.organizationId, testDb.db)
    expect(orgCourses).toHaveLength(1)
  })
})
