import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { courses, organizations, projects } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, synthetic data only (QA-3). */
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
  return { orgA, orgB }
}

describe('projects repo', () => {
  it('creates a project and reads it back', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)

    const project = projects.createProject(
      orgA,
      { name: 'Fall 2026' },
      testDb.db
    )

    expect(project).toMatchObject({ organizationId: orgA, name: 'Fall 2026' })
    expect(project.archivedAt).toBeNull()
    expect(typeof project.createdAt).toBe('number')
    expect(projects.getProject(orgA, project.id, testDb.db)).toMatchObject({
      name: 'Fall 2026',
    })
  })

  it('renames a project', () => {
    testDb = createTestDatabase()
    const { orgA } = seedTwoOrganizations(testDb)
    const project = projects.createProject(
      orgA,
      { name: 'Fall 2026' },
      testDb.db
    )

    const changed = projects.renameProject(
      orgA,
      project.id,
      'Autumn 2026',
      testDb.db
    )

    expect(changed).toBe(1)
    expect(projects.getProject(orgA, project.id, testDb.db)).toMatchObject({
      name: 'Autumn 2026',
    })
  })

  // TEN-2: every read, update and delete on `projects` is scoped by
  // organization — org B never sees or mutates org A's project.
  describe('tenant scoping (TEN-2)', () => {
    it("getProject returns undefined for another organization's project", () => {
      testDb = createTestDatabase()
      const { orgA, orgB } = seedTwoOrganizations(testDb)
      const project = projects.createProject(
        orgA,
        { name: 'Fall 2026' },
        testDb.db
      )

      expect(projects.getProject(orgB, project.id, testDb.db)).toBeUndefined()
    })

    it("listProjects only returns the calling organization's projects", () => {
      testDb = createTestDatabase()
      const { orgA, orgB } = seedTwoOrganizations(testDb)
      projects.createProject(orgA, { name: 'Org A term' }, testDb.db)
      projects.createProject(orgB, { name: 'Org B term' }, testDb.db)

      const rows = projects.listProjects(orgA, testDb.db)

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ name: 'Org A term' })
    })

    it('renaming through the wrong organization changes nothing', () => {
      testDb = createTestDatabase()
      const { orgA, orgB } = seedTwoOrganizations(testDb)
      const project = projects.createProject(
        orgA,
        { name: 'Fall 2026' },
        testDb.db
      )

      const changed = projects.renameProject(
        orgB,
        project.id,
        'Hijacked',
        testDb.db
      )

      expect(changed).toBe(0)
      expect(projects.getProject(orgA, project.id, testDb.db)).toMatchObject({
        name: 'Fall 2026',
      })
    })

    it('archiving through the wrong organization changes nothing', () => {
      testDb = createTestDatabase()
      const { orgA, orgB } = seedTwoOrganizations(testDb)
      const project = projects.createProject(
        orgA,
        { name: 'Fall 2026' },
        testDb.db
      )

      const changed = projects.archiveProject(orgB, project.id, testDb.db)

      expect(changed).toBe(0)
      expect(
        projects.getProject(orgA, project.id, testDb.db)?.archivedAt
      ).toBeNull()
    })
  })

  // PROJ-2: archiving deletes nothing and is reversible.
  describe('archiving (PROJ-2)', () => {
    it('archiving a project deletes nothing: its courses and categories stay readable', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      const project = projects.createProject(
        orgA,
        { name: 'Fall 2026' },
        testDb.db
      )
      const created = courses.createCourse(
        orgA,
        {
          projectId: project.id,
          title: 'Web Design',
          filePrefix: 'wd',
          enabled: true,
          adminsRole: 'admins-wd-fa26',
          studentsRole: 'students-wd-fa26',
          categories: [
            {
              name: 'Web Design - GLOBAL',
              channels: [{ name: 'chat', adminsOnly: false }],
            },
          ],
        },
        testDb.db
      )
      if (!created.ok) throw new Error('setup failed: unexpected conflict')

      const changed = projects.archiveProject(orgA, project.id, testDb.db)

      expect(changed).toBe(1)
      expect(
        projects.getProject(orgA, project.id, testDb.db)?.archivedAt
      ).not.toBeNull()
      // Nothing was deleted: the course and its category are still there.
      const stillThere = courses.getCourse(orgA, created.course.id, testDb.db)
      expect(stillThere).toMatchObject({ title: 'Web Design' })
      expect(stillThere?.categories).toHaveLength(1)
    })

    it('unarchiving restores a project', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      const project = projects.createProject(
        orgA,
        { name: 'Fall 2026' },
        testDb.db
      )
      projects.archiveProject(orgA, project.id, testDb.db)

      const changed = projects.unarchiveProject(orgA, project.id, testDb.db)

      expect(changed).toBe(1)
      expect(
        projects.getProject(orgA, project.id, testDb.db)?.archivedAt
      ).toBeNull()
    })

    it('listProjects excludes archived projects by default and includes them on request', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      const active = projects.createProject(
        orgA,
        { name: 'Fall 2026' },
        testDb.db
      )
      const archived = projects.createProject(
        orgA,
        { name: 'Spring 2026' },
        testDb.db
      )
      projects.archiveProject(orgA, archived.id, testDb.db)

      const defaultList = projects.listProjects(orgA, testDb.db)
      expect(defaultList.map((p) => p.id)).toEqual([active.id])

      const everything = projects.listProjects(orgA, testDb.db, {
        includeArchived: true,
      })
      expect(everything.map((p) => p.id).sort()).toEqual(
        [active.id, archived.id].sort()
      )
    })
  })
})
