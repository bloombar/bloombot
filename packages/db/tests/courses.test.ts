import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  courses,
  discordServers,
  organizations,
  projects,
  schema,
} from '@bloombot/db'
import type { courses as coursesRepo } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one project, synthetic data only (QA-3). */
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
    { name: 'Fall 2026' }, // same name is fine: different organizations
    testDatabase.db
  )
  return { orgA, orgB, projectA, projectB }
}

/** A minimal, valid course input, overridable per test. */
function courseInput(
  projectId: string,
  overrides: Partial<coursesRepo.NewCourse> = {}
): coursesRepo.NewCourse {
  return {
    projectId,
    title: 'Web Design',
    enabled: true,
    adminsRole: 'admins-wd-fa26',
    studentsRole: 'students-wd-fa26',
    categories: [
      {
        name: 'Web Design - GLOBAL',
        channels: [{ name: 'announcements', adminsOnly: true }],
      },
    ],
    ...overrides,
  }
}

function expectOk(
  result: coursesRepo.SaveCourseResult | undefined
): coursesRepo.CourseWithCategories {
  if (!result || !result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  }
  return result.course
}

describe('courses repo', () => {
  it('creates a course with its categories and channels, in order', () => {
    testDb = createTestDatabase()
    const { orgA, projectA } = seedTwoOrganizations(testDb)

    const result = courses.createCourse(
      orgA,
      courseInput(projectA.id, {
        categories: [
          { name: 'GLOBAL', channels: [{ name: 'chat', adminsOnly: false }] },
          {
            name: 'STUDENTS 01',
            channels: [
              { name: 'help', adminsOnly: false },
              { name: 'admin-notes', adminsOnly: true },
            ],
          },
        ],
      }),
      testDb.db
    )

    const course = expectOk(result)
    expect(course).toMatchObject({ title: 'Web Design', enabled: true })
    expect(course.categories.map((c) => c.name)).toEqual([
      'GLOBAL',
      'STUDENTS 01',
    ])
    expect(course.categories[1]?.channels.map((c) => c.name)).toEqual([
      'help',
      'admin-notes',
    ])

    // Reads back the same order from the database, not just from the
    // in-memory return value of createCourse.
    const fetched = courses.getCourse(orgA, course.id, testDb.db)
    expect(fetched?.categories.map((c) => c.name)).toEqual([
      'GLOBAL',
      'STUDENTS 01',
    ])
    expect(fetched?.categories[1]?.channels.map((c) => c.name)).toEqual([
      'help',
      'admin-notes',
    ])
  })

  // `getCourse` must sort by the `ordering` column, not by SQLite's
  // incidental row-storage order — which happens to match insertion order
  // for every other test here, and so would not catch a `getCourse` that
  // forgot `.orderBy(...)` entirely. Rows are inserted directly, out of
  // `ordering` order, so only an explicit `ORDER BY ordering` can produce
  // the expected result.
  it('orders categories and channels by their `ordering` column, not by insertion order', () => {
    testDb = createTestDatabase()
    const { orgA, projectA } = seedTwoOrganizations(testDb)
    const created = expectOk(
      courses.createCourse(
        orgA,
        courseInput(projectA.id, { categories: [] }),
        testDb.db
      )
    )
    const now = Date.now()
    const categoryB = randomUUID()
    const categoryA = randomUUID()
    // Inserted in this order: B, then A — but B's `ordering` (1) is after
    // A's (0), so only a correct `ORDER BY ordering` puts A first.
    testDb.db
      .insert(schema.courseCategories)
      .values({
        id: categoryB,
        organizationId: orgA,
        courseId: created.id,
        name: 'B',
        ordering: 1,
        createdAt: now,
      })
      .run()
    testDb.db
      .insert(schema.courseCategories)
      .values({
        id: categoryA,
        organizationId: orgA,
        courseId: created.id,
        name: 'A',
        ordering: 0,
        createdAt: now,
      })
      .run()
    const channelY = randomUUID()
    const channelX = randomUUID()
    testDb.db
      .insert(schema.courseChannels)
      .values({
        id: channelY,
        organizationId: orgA,
        categoryId: categoryA,
        name: 'y',
        adminsOnly: false,
        ordering: 1,
        createdAt: now,
      })
      .run()
    testDb.db
      .insert(schema.courseChannels)
      .values({
        id: channelX,
        organizationId: orgA,
        categoryId: categoryA,
        name: 'x',
        adminsOnly: false,
        ordering: 0,
        createdAt: now,
      })
      .run()

    const fetched = courses.getCourse(orgA, created.id, testDb.db)

    expect(fetched?.categories.map((c) => c.name)).toEqual(['A', 'B'])
    expect(fetched?.categories[0]?.channels.map((c) => c.name)).toEqual([
      'x',
      'y',
    ])
  })

  it('updating a course replaces its categories and channels coherently, leaving no orphans', () => {
    testDb = createTestDatabase()
    const { orgA, projectA } = seedTwoOrganizations(testDb)
    const created = expectOk(
      courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          categories: [
            { name: 'GLOBAL', channels: [{ name: 'chat', adminsOnly: false }] },
          ],
        }),
        testDb.db
      )
    )

    const updated = expectOk(
      courses.updateCourse(
        orgA,
        created.id,
        courseInput(projectA.id, {
          title: 'Web Design',
          categories: [
            {
              name: 'REPLACED',
              channels: [{ name: 'new-chat', adminsOnly: false }],
            },
          ],
        }),
        testDb.db
      )
    )

    expect(updated.categories.map((c) => c.name)).toEqual(['REPLACED'])
    expect(updated.categories[0]?.channels.map((c) => c.name)).toEqual([
      'new-chat',
    ])

    // No orphaned rows: fetching fresh from the database shows only the new set.
    const fetched = courses.getCourse(orgA, created.id, testDb.db)
    expect(fetched?.categories).toHaveLength(1)
    expect(fetched?.categories[0]?.channels).toHaveLength(1)
  })

  // Finding 6 of the CONV-1 rework: before this, `NewCourse` had no
  // `conversationScope` field at all, so a course's `conversation_scope`
  // could only ever be its database default — CONV-1's `course_surface`
  // half was unreachable through this package's own API.
  describe('conversationScope (CONV-1)', () => {
    it('defaults to `course` when omitted on create', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      expect(created.conversationScope).toBe('course')
    })

    it('is written as given on create', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const created = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, { conversationScope: 'course_surface' }),
          testDb.db
        )
      )

      expect(created.conversationScope).toBe('course_surface')
      expect(courses.getCourse(orgA, created.id, testDb.db)).toMatchObject({
        conversationScope: 'course_surface',
      })
    })

    it('is replaced on update, defaulting back to `course` when omitted', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, { conversationScope: 'course_surface' }),
          testDb.db
        )
      )

      const updated = expectOk(
        courses.updateCourse(
          orgA,
          created.id,
          courseInput(projectA.id), // no `conversationScope` this time
          testDb.db
        )
      )

      expect(updated.conversationScope).toBe('course')
    })
  })

  it('lists and enables/disables a course', () => {
    testDb = createTestDatabase()
    const { orgA, projectA } = seedTwoOrganizations(testDb)
    const created = expectOk(
      courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
    )

    expect(courses.listCourses(orgA, testDb.db)).toHaveLength(1)

    expect(courses.disableCourse(orgA, created.id, testDb.db)).toBe(1)
    expect(courses.getCourse(orgA, created.id, testDb.db)).toMatchObject({
      enabled: false,
    })

    expect(courses.enableCourse(orgA, created.id, testDb.db)).toEqual({
      ok: true,
      changed: true,
    })
    expect(courses.getCourse(orgA, created.id, testDb.db)).toMatchObject({
      enabled: true,
    })
  })

  // Cheap-fix 6: a caller that treats "changed" as "this actually happened"
  // must not be lied to by a repeat call.
  it('enabling an already-enabled course, or disabling an already-disabled one, is a no-op', () => {
    testDb = createTestDatabase()
    const { orgA, projectA } = seedTwoOrganizations(testDb)
    const created = expectOk(
      courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
    )

    // Already enabled: enabling again reports `changed: false`, not `true`.
    expect(courses.enableCourse(orgA, created.id, testDb.db)).toEqual({
      ok: true,
      changed: false,
    })

    courses.disableCourse(orgA, created.id, testDb.db)
    // Already disabled: disabling again is `0` rows changed, not `1`.
    expect(courses.disableCourse(orgA, created.id, testDb.db)).toBe(0)
  })

  it('lists only the courses in a given project', () => {
    testDb = createTestDatabase()
    const { orgA, projectA } = seedTwoOrganizations(testDb)
    const otherProject = projects.createProject(
      orgA,
      { name: 'Spring 2027' },
      testDb.db
    )
    expectOk(courses.createCourse(orgA, courseInput(projectA.id), testDb.db))
    expectOk(
      courses.createCourse(
        orgA,
        courseInput(otherProject.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-sp27',
          studentsRole: 'students-ds-sp27',
          categories: [],
        }),
        testDb.db
      )
    )

    const rows = courses.listCourses(orgA, testDb.db, {
      projectId: projectA.id,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Web Design' })
  })

  // Finding 14 of the SURF-1 rework: the routing projection `@bloombot/discord`
  // reads instead of one `getCourse` call per course.
  describe('listRoutableCourses (finding 14)', () => {
    it('attaches each course its own category names, keyed correctly', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const webDesign = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )
      const dataScience = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-ds',
            studentsRole: 'students-ds',
            categories: [
              { name: 'Data Science - A', channels: [] },
              { name: 'Data Science - B', channels: [] },
            ],
          }),
          testDb.db
        )
      )

      const rows = courses.listRoutableCourses(orgA, testDb.db)

      const byId = new Map(rows.map((row) => [row.id, row]))
      expect(byId.get(webDesign.id)).toMatchObject({
        title: 'Web Design',
        categoryNames: ['Web Design - GLOBAL'],
        adminsRole: 'admins-wd-fa26',
        studentsRole: 'students-wd-fa26',
        enabled: true,
      })
      expect(byId.get(dataScience.id)?.categoryNames.sort()).toEqual(
        ['Data Science - A', 'Data Science - B'].sort()
      )
    })

    // PROJ-2/finding 2: an archived project's courses do not route — this is
    // the one function `@bloombot/discord`'s routing reads from, so the
    // filter belongs here, not left to every caller to apply itself.
    it("excludes a course whose project is archived, and only that organization's courses", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, projectA, projectB } = seedTwoOrganizations(testDb)
      const live = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )
      const archivedProject = projects.createProject(
        orgA,
        { name: 'Spring 2020' },
        testDb.db
      )
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(archivedProject.id, {
            title: 'Old Course',
            adminsRole: 'admins-old',
            studentsRole: 'students-old',
            categories: [{ name: 'Old Course - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      projects.archiveProject(orgA, archivedProject.id, testDb.db)
      expectOk(
        courses.createCourse(
          orgB,
          courseInput(projectB.id, {
            adminsRole: 'admins-wd-fa26', // same names are fine: a different organization
            studentsRole: 'students-wd-fa26',
          }),
          testDb.db
        )
      )

      const rows = courses.listRoutableCourses(orgA, testDb.db)

      expect(rows.map((row) => row.id)).toEqual([live.id])
    })

    it('returns an empty array for an organization with no routable courses', () => {
      testDb = createTestDatabase()
      const { orgA } = seedTwoOrganizations(testDb)
      expect(courses.listRoutableCourses(orgA, testDb.db)).toEqual([])
    })
  })

  // TEN-2: every read, update and delete on courses (and, through them,
  // their categories and channels) is scoped by organization.
  describe('tenant scoping (TEN-2)', () => {
    it("getCourse returns undefined for another organization's course", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      expect(courses.getCourse(orgB, created.id, testDb.db)).toBeUndefined()
    })

    it("listCourses only returns the calling organization's courses", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, projectA, projectB } = seedTwoOrganizations(testDb)
      expectOk(courses.createCourse(orgA, courseInput(projectA.id), testDb.db))
      expectOk(
        courses.createCourse(
          orgB,
          courseInput(projectB.id, {
            adminsRole: 'admins-wd-fa26', // same names are fine: a different organization
            studentsRole: 'students-wd-fa26',
          }),
          testDb.db
        )
      )

      expect(courses.listCourses(orgA, testDb.db)).toHaveLength(1)
      expect(courses.listCourses(orgB, testDb.db)).toHaveLength(1)
    })

    // The bug the last slice hid: a naive scope check on the pre-check but
    // not on the write itself lets a foreign organization mutate a record it
    // does not own. Here, org B calling with org A's own course id must not
    // touch org A's row.
    it('updating, enabling or disabling through the wrong organization changes nothing', () => {
      testDb = createTestDatabase()
      const { orgA, orgB, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      const updateResult = courses.updateCourse(
        orgB,
        created.id,
        courseInput(projectA.id, { title: 'Hijacked' }),
        testDb.db
      )
      expect(updateResult).toBeUndefined()
      expect(courses.enableCourse(orgB, created.id, testDb.db)).toBeUndefined()
      expect(courses.disableCourse(orgB, created.id, testDb.db)).toBe(0)

      const stillOwnedByA = courses.getCourse(orgA, created.id, testDb.db)
      expect(stillOwnedByA).toMatchObject({
        title: 'Web Design',
        enabled: true,
      })
    })
  })

  // PROJ-3: category and role names must be unique across every enabled
  // course in an organization, regardless of project.
  describe('name collisions (PROJ-3)', () => {
    it('refuses a colliding category name, naming the conflicting project and course', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'students-ds-fa26',
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'category',
        name: 'GLOBAL',
        conflictingProjectName: 'Fall 2026',
        conflictingCourseTitle: 'Web Design',
      })
      expect(result.conflict.message).toContain('Web Design')
      expect(result.conflict.message).toContain('Fall 2026')
    })

    it('refuses a colliding role name, naming the conflicting project and course', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: 'admins-wd-fa26',
            studentsRole: 'students-wd-fa26',
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-wd-fa26', // collides with Web Design's admin role
          studentsRole: 'students-ds-fa26',
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'adminsRole',
        name: 'admins-wd-fa26',
        conflictingCourseTitle: 'Web Design',
        conflictingProjectName: 'Fall 2026',
      })
    })

    it("allows the same name once the conflicting course's project is archived", () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      projects.archiveProject(orgA, projectA.id, testDb.db)

      const newProject = projects.createProject(
        orgA,
        { name: 'Spring 2027' },
        testDb.db
      )
      const result = courses.createCourse(
        orgA,
        courseInput(newProject.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-sp27',
          studentsRole: 'students-ds-sp27',
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })

    it('allows the same name once the conflicting course is disabled', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const first = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      courses.disableCourse(orgA, first.id, testDb.db)

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'students-ds-fa26',
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })

    // The case a naive implementation misses: updating a course into a
    // collision with a *different* course, not with its own prior state.
    it('refuses on update, not just create, when a course is renamed into a collision', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      const dataScience = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-ds-fa26',
            studentsRole: 'students-ds-fa26',
            categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.updateCourse(
        orgA,
        dataScience.id,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'students-ds-fa26',
          categories: [{ name: 'GLOBAL', channels: [] }], // now collides with Web Design
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'category',
        name: 'GLOBAL',
        conflictingCourseTitle: 'Web Design',
      })
    })

    // A no-op re-save (or a rename that keeps every name distinct) must not
    // be refused for "colliding" with its own prior state.
    it('updating a course without changing its names is not refused for colliding with itself', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      const result = courses.updateCourse(
        orgA,
        created.id,
        courseInput(projectA.id, { title: 'Web Design (renamed)' }),
        testDb.db
      )

      expect(result?.ok).toBe(true)
    })

    // Must-fix 3: the collision check only applies to a save that would
    // actually route. A disabled course's names are free for someone else to
    // take, and taking them must not lock the disabled course out of every
    // future edit — including one that leaves it disabled.
    it('a title-only edit of a disabled course is allowed even if its names are now taken elsewhere', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const webDesign = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            enabled: false,
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      // Data Science reuses Web Design's now-free names.
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-wd-fa26',
            studentsRole: 'students-wd-fa26',
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.updateCourse(
        orgA,
        webDesign.id,
        courseInput(projectA.id, {
          enabled: false,
          title: 'Web Design (renamed)',
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result?.ok).toBe(true)
    })

    // The same escape hatch on create, not just update: creating a disabled
    // course that reuses names already taken by an enabled course must be
    // allowed — it introduces no routing collision.
    it('creating a disabled course that reuses names taken by an enabled course is allowed', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          enabled: false,
          title: 'Data Science',
          adminsRole: 'admins-wd-fa26',
          studentsRole: 'students-wd-fa26',
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })

    // Must-fix 5: self-consistency within a single save, not just across two.
    it('refuses a save whose admin and student role are the same name', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          adminsRole: 'same-role',
          studentsRole: 'same-role',
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('studentsRole')
      expect(result.conflict.name).toBe('same-role')
    })

    // SRV-10's own rework: `apps/worker`'s role resolution
    // (`discordServers.scaffold`/`roster.import`) compares a course's role
    // names against a Discord guild's own roles case- and
    // whitespace-insensitively — this check has to match that, or a course
    // naming `adminsRole: "Staff"` and `studentsRole: "staff"` passes here
    // as two different names and then resolves onto the very same Discord
    // role once scaffolded, granting the admins-only overwrite to every
    // student. This test fails without the fix: before it, differently
    // cased/spaced names were accepted as distinct.
    it('refuses a save whose admin and student role are the same name once case and surrounding whitespace are ignored', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          adminsRole: 'Staff',
          studentsRole: '  staff  ',
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('studentsRole')
    })

    // SRV-10 round 3, must-fix 2: the message used to quote only
    // `studentsRole`, leaving an instructor looking at two visibly
    // different strings ("Staff"/"staff") with no explanation of why they
    // collide. This test fails without the fix: before it, the message
    // read `Role name "staff" is used for both...`, naming neither the
    // other value nor the case/whitespace-insensitivity that makes them
    // the same role to Discord.
    it('names both role values and explains the case/whitespace-insensitivity when they differ only that way', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          adminsRole: 'Staff',
          studentsRole: '  staff  ',
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.message).toContain('"Staff"')
      expect(result.conflict.message).toContain('"  staff  "')
      expect(result.conflict.message.toLowerCase()).toContain('capitalization')
    })

    // SRV-10 round 3, must-fix 1: a course already stored with an aliasing
    // pair (grandfathered — saved before the check above existed, or
    // written directly the way this test does) must still accept a save
    // that leaves the pair untouched. This test fails without the fix:
    // before it, `courses.save` always sending both role fields meant this
    // update was refused for a field the caller never touched, blocking
    // every unrelated edit on such a course forever.
    it('accepts an update that leaves a stored aliasing role pair untouched, changing only an unrelated field', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )
      // Grandfathered directly, below the repo layer — the same device
      // this file's own TEN-9 test uses to reach a state `createCourse`
      // itself now refuses to produce.
      testDb.db.$client
        .prepare(
          'UPDATE courses SET admins_role = ?, students_role = ? WHERE id = ?'
        )
        .run('Staff', 'staff', created.id)

      const result = courses.updateCourse(
        orgA,
        created.id,
        courseInput(projectA.id, {
          title: 'Web Design (renamed)',
          adminsRole: 'Staff',
          studentsRole: 'staff',
        }),
        testDb.db
      )

      expect(result?.ok).toBe(true)
      if (!result?.ok) throw new Error('expected the save to go through')
      expect(result.course.title).toBe('Web Design (renamed)')
    })

    // The other half of must-fix 1: a save that *introduces* aliasing (or
    // changes one already-aliasing name to alias with something else) is
    // still refused in full — untouched-pair leniency must not become
    // blanket leniency the moment either role field is present in the
    // input.
    it('still refuses an update that changes a role name into a new aliasing pair', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      const result = courses.updateCourse(
        orgA,
        created.id,
        courseInput(projectA.id, {
          adminsRole: 'same-role',
          studentsRole: 'same-role',
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('studentsRole')
    })

    it('refuses a save with two categories sharing the same name', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          categories: [
            { name: 'GLOBAL', channels: [] },
            { name: 'GLOBAL', channels: [] },
          ],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'category',
        name: 'GLOBAL',
      })
    })

    it('refuses an update whose admin and student role are the same name', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      const result = courses.updateCourse(
        orgA,
        created.id,
        courseInput(projectA.id, {
          adminsRole: 'same-role',
          studentsRole: 'same-role',
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('studentsRole')
    })

    // PROJ-7: a course may name no role at all. Absent is not a value —
    // two role-less courses must not collide with each other, and a
    // role-less course must not collide with (or be collided into by) a
    // course that names one. These fail without the fix: a naive port of
    // the null-safety above (`normalizeRoleName(null) === normalizeRoleName(null)`)
    // would say two absent roles are "the same role name."
    it('two courses that both name no role at all do not collide with each other', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: null,
            studentsRole: null,
            categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: null,
          studentsRole: null,
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })

    // A course naming one role and no role at all — the "one absent, one
    // present" case — must not collide either: the role-less course has
    // nothing to compare, and the other course's one set role is simply
    // not shared.
    it('a role-less course and a course naming one role do not collide', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: 'admins-wd-fa26',
            studentsRole: null,
            categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: null,
          studentsRole: null,
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })

    // The control on the two tests above: two courses that *do* share a
    // present role must still collide — PROJ-7 only exempts an absent role,
    // never a real one.
    it('two courses sharing a present role still collide', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: 'shared-admins-role',
            studentsRole: null,
            categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'shared-admins-role',
          studentsRole: null,
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('adminsRole')
    })

    // The self-conflict half (`findSelfConflict`): a course naming no role
    // at all must not be refused for "the admin and student role are the
    // same name" — two absent roles are not the same name, they are both
    // absent.
    it('a course naming no role at all does not self-conflict', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          adminsRole: null,
          studentsRole: null,
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })
  })

  // SRV-10 made a course's *own* two role names compare case- and
  // whitespace-insensitively, so one course can no longer name `Staff` and
  // `staff` and have both resolve to a single Discord role. The cross-course
  // check was still exact, so course A naming `Staff` as its admins role and
  // course B naming `staff` as its students role were both accepted — and at
  // scaffold time both resolved to the same Discord role, granting course
  // B's students course A's admins-only channels. These tests fail without
  // the fix: before it, `findCourseNameConflict` compared role names by
  // exact string, so a differently cased/spaced pair across two courses was
  // never caught.
  describe('cross-course role name collisions ignore case and whitespace (SRV-11)', () => {
    it('refuses a second course whose role name differs from the first only in case, naming the other course', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: 'Staff',
            studentsRole: 'students-wd-fa26',
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: '  staff  ', // same Discord role as Web Design's admins role
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'studentsRole',
        name: '  staff  ',
        conflictingCourseTitle: 'Web Design',
        conflictingProjectName: 'Fall 2026',
      })
      expect(result.conflict.message).toContain('Web Design')
    })

    // The other half of grandfathering (SRV-10 round 3, must-fix 1, applied
    // across courses instead of within one): a pair of courses already
    // stored with role names that alias under Discord's matching — saved
    // before this check existed — must still accept a save that leaves both
    // courses' role names untouched. This test fails without the fix applying
    // `checkRoles`/`rolesChanged` to the cross-course check: before it, the
    // now-normalized comparison caught the pre-existing pair on every future
    // save, refusing even a save that only renames the course.
    it('accepts an update that leaves a grandfathered cross-course collision untouched, changing only an unrelated field', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: 'admins-wd-fa26',
            studentsRole: 'staff',
          }),
          testDb.db
        )
      )
      const dataScience = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-ds-fa26',
            studentsRole: 'students-ds-fa26',
            categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      // Grandfathered directly, below the repo layer — Data Science's admin
      // role now aliases with Web Design's students role, a state
      // `createCourse` itself would now refuse to produce.
      testDb.db.$client
        .prepare('UPDATE courses SET admins_role = ? WHERE id = ?')
        .run('Staff', dataScience.id)

      const result = courses.updateCourse(
        orgA,
        dataScience.id,
        courseInput(projectA.id, {
          title: 'Data Science (renamed)',
          adminsRole: 'Staff',
          studentsRole: 'students-ds-fa26',
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result?.ok).toBe(true)
      if (!result?.ok) throw new Error('expected the save to go through')
      expect(result.course.title).toBe('Data Science (renamed)')
    })

    // The other half: untouched-pair leniency must not become blanket
    // leniency the moment either role field is present in the input — a
    // save that actually changes a role name into a new cross-course
    // collision is still refused in full.
    it('still refuses an update that changes a role name into a new cross-course collision', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: 'Staff',
            studentsRole: 'students-wd-fa26',
          }),
          testDb.db
        )
      )
      const dataScience = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-ds-fa26',
            studentsRole: 'students-ds-fa26',
            categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.updateCourse(
        orgA,
        dataScience.id,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: '  staff  ', // now aliases with Web Design's admins role
          studentsRole: 'students-ds-fa26',
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'adminsRole',
        conflictingCourseTitle: 'Web Design',
      })
    })

    // The conflict is scoped to one organization (the same scope
    // `findCourseNameConflict` already applies, per `docs/DECISIONS.md`) —
    // two unrelated organizations may each name a role however they like,
    // even identically, since neither's Discord server (if any) is shared.
    it('allows two different organizations to name the same role, even differing only in case', () => {
      testDb = createTestDatabase()
      const { orgA, orgB, projectA, projectB } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            adminsRole: 'Staff',
            studentsRole: 'students-wd-fa26',
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgB,
        courseInput(projectB.id, {
          adminsRole: 'staff', // same role name, different organization
          studentsRole: 'students-wd-fa26-b',
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })

    // Round 2 must-fix: `rolesChanged` alone is not a sound gate for the
    // cross-course check, unlike the self-conflict check it was copied
    // from — `findCourseNameConflict`'s candidate set also depends on
    // `discordServerId`, `enabled` and `projectId`, all reachable from
    // `courses.save`. These three tests fail without the fix: each moves a
    // course into a colliding candidate set without touching either role
    // name, and the unconditional `rolesChanged` gate let all three through.
    it('refuses a save that moves a course into a server where its role name (byte-identical) collides', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      const serverA = discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '323232323232323232', installedByAccountId: installer.id },
        testDb.db
      )
      const serverB = discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '333333333333333333', installedByAccountId: installer.id },
        testDb.db
      )
      if (!serverA || !serverB) throw new Error('expected both to claim')

      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Web Design',
            adminsRole: 'staff',
            discordServerId: serverA.serverId,
            categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      const dataScience = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-ds-fa26',
            studentsRole: 'staff', // byte-identical to serverA's "staff", but currently in serverB
            discordServerId: serverB.serverId,
            categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      // Moves Data Science into serverA, where its `studentsRole` collides
      // with Web Design's `adminsRole` — the role names never change.
      const result = courses.updateCourse(
        orgA,
        dataScience.id,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'staff',
          discordServerId: serverA.serverId,
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'studentsRole',
        conflictingCourseTitle: 'Web Design',
      })
    })

    it('refuses a save that enables a disabled course into a role collision (byte-identical) — the enable-via-update path', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Web Design',
            adminsRole: 'staff',
            categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      const dataScience = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            enabled: false,
            title: 'Data Science',
            adminsRole: 'admins-ds-fa26',
            studentsRole: 'staff', // byte-identical to Web Design's admins role
            categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      // `courses.save` with `enabled: true` — a second, unguarded way to
      // enable a course besides `courses.enable` (`enableCourse`, which
      // does re-run this check).
      const result = courses.updateCourse(
        orgA,
        dataScience.id,
        courseInput(projectA.id, {
          enabled: true,
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'staff',
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'studentsRole',
        conflictingCourseTitle: 'Web Design',
      })
    })

    it('refuses a save that moves a course out of an archived project into a role collision (byte-identical)', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Web Design',
            adminsRole: 'staff',
            categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      // Archived *before* Data Science is created in it, so its colliding
      // role name is never itself a candidate at creation time (PROJ-2) —
      // this test is about the state a project's own courses can already be
      // in when it comes back, not about `createCourse`'s own check.
      const archivedProject = projects.createProject(
        orgA,
        { name: 'Archived Term' },
        testDb.db
      )
      projects.archiveProject(orgA, archivedProject.id, testDb.db)
      const dataScience = expectOk(
        courses.createCourse(
          orgA,
          courseInput(archivedProject.id, {
            title: 'Data Science',
            adminsRole: 'admins-ds-fa26',
            studentsRole: 'staff', // byte-identical to Web Design's admins role
            categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      // Moves Data Science into the live project, where its `studentsRole`
      // collides with Web Design's `adminsRole` — the role names never
      // change, only `projectId` does.
      const result = courses.updateCourse(
        orgA,
        dataScience.id,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'staff',
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'studentsRole',
        conflictingCourseTitle: 'Web Design',
      })
    })

    // The refusal quotes the candidate's *own* spelling, not just the
    // caller's — otherwise an instructor naming "staff" is told it collides
    // with a course that visibly uses "Staff", with no indication the two
    // are the same role to Discord. This test fails without the fix: before
    // it, the message read `Role name "staff" is already used by course
    // "Web Design"...` with no mention of "Staff" anywhere.
    it("names the candidate's own spelling and explains the insensitivity when the two spellings differ", () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Web Design',
            adminsRole: 'Staff',
            categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'staff',
          categories: [{ name: 'Data Science - GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.message).toContain('"staff"')
      expect(result.conflict.message).toContain('"Staff"')
      expect(result.conflict.message.toLowerCase()).toContain('case')
    })
  })

  // TEN-9 — PROJ-3's own text always said "unique across every enabled
  // course in *that server*": two courses that route in different servers
  // may now share a category or role name, and two in the same server still
  // may not.
  describe('name collisions are scoped to a server (TEN-9)', () => {
    it('allows the same category and role names across two different servers', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      const serverA = discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '303030303030303030', installedByAccountId: installer.id },
        testDb.db
      )
      const serverB = discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '313131313131313131', installedByAccountId: installer.id },
        testDb.db
      )
      if (!serverA || !serverB) throw new Error('expected both to claim')

      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            discordServerId: serverA.serverId,
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      // Same category and role names, but routed into `serverB` — this must
      // not collide, since PROJ-3 is now scoped per server, not per
      // organization.
      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          discordServerId: serverB.serverId,
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })

    it('still refuses the same category name for two courses both in the same server', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer2@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      const serverA = discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '323232323232323232', installedByAccountId: installer.id },
        testDb.db
      )
      const serverB = discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '333333333333333333', installedByAccountId: installer.id },
        testDb.db
      )
      if (!serverA || !serverB) throw new Error('expected both to claim')

      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            discordServerId: serverA.serverId,
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'students-ds-fa26',
          discordServerId: serverA.serverId,
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('category')
    })

    it('refuses to enable a course while its server is ambiguous (null column, two active bindings)', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer3@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '343434343434343434', installedByAccountId: installer.id },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '353535353535353535', installedByAccountId: installer.id },
        testDb.db
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, { discordServerId: null }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('discordServerId')
      expect(result.conflict.name).toBe('ambiguous')
    })

    it('refuses to enable a course whose own server has since been removed', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer4@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      const serverId = '363636363636363636'
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId, installedByAccountId: installer.id },
        testDb.db
      )
      const created = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            enabled: false,
            discordServerId: serverId,
          }),
          testDb.db
        )
      )
      discordServers.removeDiscordServerBinding(orgA, serverId, testDb.db)

      const result = courses.enableCourse(orgA, created.id, testDb.db)

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('discordServerId')
      expect(result.conflict.name).toBe('removed')
    })

    // Cheap-fix 4 (coordinator round 1 rework): `updateCourse`'s own
    // server-resolution refusal branch — `createCourse`'s and
    // `enableCourse`'s each already had a test above; `updateCourse`'s did
    // not.
    it('refuses an update that would enable a course while its server is ambiguous', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer-update-ambiguous@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      const serverA = discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '444444444444444401',
          installedByAccountId: installer.id,
        },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '444444444444444402',
          installedByAccountId: installer.id,
        },
        testDb.db
      )
      if (!serverA) throw new Error('setup failed: expected a claim')
      const created = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            enabled: false,
            discordServerId: serverA.serverId,
          }),
          testDb.db
        )
      )

      const result = courses.updateCourse(
        orgA,
        created.id,
        courseInput(projectA.id, {
          enabled: true,
          discordServerId: null,
        }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('discordServerId')
      expect(result.conflict.name).toBe('ambiguous')
      // Cheap-fix 5: names the course the refusal is about.
      expect(result.conflict.conflictingCourseTitle).toBe(created.title)
    })

    // Cheap-fix 4: `findProjectUnarchiveConflict`'s own server-resolution
    // refusal — a new way for unarchiving a project to fail, introduced by
    // this slice, that had no test at all.
    it('refuses to unarchive a project holding an enabled course whose server is ambiguous, naming the course', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer-unarchive-ambiguous@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      const serverA = discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '444444444444444403',
          installedByAccountId: installer.id,
        },
        testDb.db
      )
      if (!serverA) throw new Error('setup failed: expected a claim')
      // Enabled, with a null server, while the organization still holds
      // only one active binding — resolvable, and legal, at the time.
      const created = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, { discordServerId: null }),
          testDb.db
        )
      )
      projects.archiveProject(orgA, projectA.id, testDb.db)
      // A second binding is claimed *after* the project (and its course)
      // is archived — TEN-9's own backfill only runs against currently
      // null-server courses at the moment of the claim, and this course's
      // own column is still null at that moment, so it is backfilled too;
      // clear it back to null directly (below the repo layer) to reach the
      // genuinely-ambiguous state this test targets: a project reactivating
      // an enabled course whose own server this organization can no longer
      // resolve.
      discordServers.claimDiscordServerBinding(
        orgA,
        {
          serverId: '444444444444444404',
          installedByAccountId: installer.id,
        },
        testDb.db
      )
      testDb.db.$client
        .prepare('UPDATE courses SET discord_server_id = NULL WHERE id = ?')
        .run(created.id)

      const conflict = courses.findProjectUnarchiveConflict(
        orgA,
        projectA.id,
        testDb.db
      )

      expect(conflict?.field).toBe('discordServerId')
      expect(conflict?.name).toBe('ambiguous')
      // Cheap-fix 5: names which of the project's own courses is undecided.
      expect(conflict?.conflictingCourseTitle).toBe(created.title)
    })

    it('a null discordServerId in an organization with exactly one active binding still collides with another null-server course, unchanged', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const installer = accounts.createAccount(
        orgA,
        {
          email: 'installer5@example.edu',
          displayName: 'Installer',
          role: 'owner',
        },
        testDb.db
      )
      discordServers.claimDiscordServerBinding(
        orgA,
        { serverId: '373737373737373737', installedByAccountId: installer.id },
        testDb.db
      )

      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            discordServerId: null,
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, {
          title: 'Data Science',
          adminsRole: 'admins-ds-fa26',
          studentsRole: 'students-ds-fa26',
          discordServerId: null,
          categories: [{ name: 'GLOBAL', channels: [] }],
        }),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('category')
    })

    it('creating and enabling a course stays unrestricted in an organization with no Discord binding at all', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)

      const result = courses.createCourse(
        orgA,
        courseInput(projectA.id, { discordServerId: null }),
        testDb.db
      )

      expect(result.ok).toBe(true)
    })
  })

  // TEN-5: `projectId` must belong to the calling organization — the
  // foreign key alone only proves it belongs to *some* organization.
  describe('project ownership (TEN-5)', () => {
    it("refuses to create a course against another organization's project", () => {
      testDb = createTestDatabase()
      const { orgB, projectA } = seedTwoOrganizations(testDb)

      const result = courses.createCourse(
        orgB,
        courseInput(projectA.id),
        testDb.db
      )

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('projectId')
      expect(result.conflict.name).toBe(projectA.id)
      // The refusal must not disclose org A's project name to org B.
      expect(result.conflict.message).not.toContain('Fall 2026')
    })

    it("refuses to update a course onto another organization's project", () => {
      testDb = createTestDatabase()
      const { orgB, projectA, projectB } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgB, courseInput(projectB.id), testDb.db)
      )

      const result = courses.updateCourse(
        orgB,
        created.id,
        courseInput(projectA.id),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict.field).toBe('projectId')
    })
  })

  // Must-fix 2: re-enabling a course must not produce the state PROJ-3
  // forbids just because the check only ran at save time.
  describe('enableCourse re-runs the PROJ-3 check', () => {
    it('refuses to enable a course whose names were taken by another course while it was disabled', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const webDesign = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      courses.disableCourse(orgA, webDesign.id, testDb.db)
      // Data Science takes Web Design's freed names while it is disabled.
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-wd-fa26',
            studentsRole: 'students-wd-fa26',
            categories: [{ name: 'GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )

      const result = courses.enableCourse(orgA, webDesign.id, testDb.db)

      expect(result?.ok).toBe(false)
      if (!result || result.ok) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        conflictingCourseTitle: 'Data Science',
      })
      // Refused, so it must still read back disabled.
      expect(courses.getCourse(orgA, webDesign.id, testDb.db)).toMatchObject({
        enabled: false,
      })
    })
  })

  // FILE-4: `setCourseInstructions` writes only the one column.
  describe('setCourseInstructions', () => {
    it("updates a course's instructions and nothing else", () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const course = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      const updated = courses.setCourseInstructions(
        orgA,
        course.id,
        'Be concise and cite the syllabus.',
        testDb.db
      )

      expect(updated?.instructions).toBe('Be concise and cite the syllabus.')
      expect(updated?.title).toBe(course.title)
    })

    it("does not reach another organization's course (TEN-5)", () => {
      testDb = createTestDatabase()
      const { orgA, orgB, projectA } = seedTwoOrganizations(testDb)
      const course = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      expect(
        courses.setCourseInstructions(orgB, course.id, 'nope', testDb.db)
      ).toBeUndefined()
    })
  })

  // FILE-1/D-3: a course's vector store id is filled in once, and a
  // hand-typed one is never overwritten.
  describe('setCourseVectorStoreIdIfUnset', () => {
    it('fills in a vector store id when the course has none', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const course = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )
      expect(course.vectorStoreId).toBeNull()

      const updated = courses.setCourseVectorStoreIdIfUnset(
        orgA,
        course.id,
        'vs_generated',
        testDb.db
      )
      expect(updated?.vectorStoreId).toBe('vs_generated')
    })

    it("never overwrites a hand-typed vector store id (D-3's escape hatch)", () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const course = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, { vectorStoreId: 'vs_hand_typed' }),
          testDb.db
        )
      )

      const updated = courses.setCourseVectorStoreIdIfUnset(
        orgA,
        course.id,
        'vs_generated',
        testDb.db
      )
      expect(updated?.vectorStoreId).toBe('vs_hand_typed')
    })
  })

  describe('updateCourseSettings (ACT-7)', () => {
    /** A full `CourseSettingsUpdate`, taken from `course`'s own current values and overridable per test. */
    function settingsInput(
      course: coursesRepo.Course,
      overrides: Partial<coursesRepo.CourseSettingsUpdate> = {}
    ): coursesRepo.CourseSettingsUpdate {
      return {
        title: course.title,
        enabled: course.enabled,
        adminsRole: course.adminsRole,
        studentsRole: course.studentsRole,
        model: course.model,
        vectorStoreId: course.vectorStoreId,
        maxRequestsPerDay: course.maxRequestsPerDay,
        conversationScope: course.conversationScope,
        selfEnrolFromDiscord: course.selfEnrolFromDiscord,
        answerUnenrolled: course.answerUnenrolled,
        discordServerId: course.discordServerId,
        ...overrides,
      }
    }

    // The central test of ACT-7: a settings change must never touch a
    // course's categories or channels — this must fail if
    // `updateCourseSettings` were implemented by delegating to
    // `updateCourse`'s replace path, which gives every category and channel
    // a brand-new id even when its contents end up identical.
    it('changes a setting without touching the course categories or channels at all', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            categories: [
              {
                name: 'GLOBAL',
                channels: [{ name: 'chat', adminsOnly: false }],
              },
            ],
          }),
          testDb.db
        )
      )

      const result = courses.updateCourseSettings(
        orgA,
        created.id,
        settingsInput(created, { title: 'Web Design II' }),
        testDb.db
      )

      const updated = expectOk(result)
      expect(updated.title).toBe('Web Design II')
      // Byte-for-byte: same category and channel rows, same ids, same
      // ordering — not merely the same names and count a replace-and-reinsert
      // would also produce.
      expect(updated.categories).toEqual(created.categories)
    })

    it('returns undefined when the course does not exist or belongs to another organization (TEN-2)', () => {
      testDb = createTestDatabase()
      const { orgA, orgB, projectA } = seedTwoOrganizations(testDb)
      const created = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      const result = courses.updateCourseSettings(
        orgB,
        created.id,
        settingsInput(created),
        testDb.db
      )

      expect(result).toBeUndefined()
    })

    it('reuses the PROJ-3 cross-course collision check', () => {
      testDb = createTestDatabase()
      const { orgA, projectA } = seedTwoOrganizations(testDb)
      expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            title: 'Data Science',
            adminsRole: 'admins-ds-fa26',
            studentsRole: 'students-ds-fa26',
            categories: [{ name: 'DS GLOBAL', channels: [] }],
          }),
          testDb.db
        )
      )
      const webDesign = expectOk(
        courses.createCourse(orgA, courseInput(projectA.id), testDb.db)
      )

      const result = courses.updateCourseSettings(
        orgA,
        webDesign.id,
        // Colliding with Data Science's own admins role.
        settingsInput(webDesign, { studentsRole: 'admins-ds-fa26' }),
        testDb.db
      )

      expect(result?.ok).toBe(false)
      if (result?.ok !== false) throw new Error('expected a conflict')
      expect(result.conflict).toMatchObject({
        field: 'studentsRole',
        name: 'admins-ds-fa26',
        conflictingCourseTitle: 'Data Science',
      })
      // Refused before any write — the stored role is still what it was.
      expect(
        courses.getCourse(orgA, webDesign.id, testDb.db)?.studentsRole
      ).toBe('students-wd-fa26')
    })
  })

  describe('SRV-12 — categories and channels edited one piece at a time', () => {
    /** A course with two categories, each with a channel — enough siblings for every "leaves everything else untouched" assertion below to actually mean something. */
    function seedCourseWithTwoCategories(testDatabase: TestDatabase) {
      const { orgA, projectA } = seedTwoOrganizations(testDatabase)
      const created = expectOk(
        courses.createCourse(
          orgA,
          courseInput(projectA.id, {
            enabled: false, // no PROJ-3 candidate set to worry about by default
            categories: [
              {
                name: 'GLOBAL',
                channels: [{ name: 'announcements', adminsOnly: true }],
              },
              {
                name: 'WEEK 1',
                channels: [{ name: 'help', adminsOnly: false }],
              },
            ],
          }),
          testDatabase.db
        )
      )
      return { orgA, course: created }
    }

    describe('addCourseCategory', () => {
      it('appends after the existing categories, ordering = max + 1, leaving them untouched', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)

        const result = courses.addCourseCategory(
          orgA,
          course.id,
          'WEEK 2',
          testDb.db
        )
        if (!result?.ok) throw new Error('expected ok')
        expect(result.category).toMatchObject({ name: 'WEEK 2', ordering: 2 })
        expect(result.category.channels).toEqual([])

        const fetched = courses.getCourse(orgA, course.id, testDb.db)
        expect(fetched?.categories.map((c) => c.name)).toEqual([
          'GLOBAL',
          'WEEK 1',
          'WEEK 2',
        ])
        // The original two categories (and their channels) are the exact
        // same rows — same ids — not replaced and reinserted.
        expect(fetched?.categories[0]).toEqual(course.categories[0])
        expect(fetched?.categories[1]).toEqual(course.categories[1])
      })

      it('refuses a duplicate category name within the same course (PROJ-3 self-conflict)', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)

        const result = courses.addCourseCategory(
          orgA,
          course.id,
          'GLOBAL',
          testDb.db
        )

        expect(result?.ok).toBe(false)
        if (result?.ok !== false) throw new Error('expected a conflict')
        expect(result.conflict.field).toBe('category')
        // Refused before any write.
        expect(
          courses.getCourse(orgA, course.id, testDb.db)?.categories
        ).toHaveLength(2)
      })

      it('refuses a category name colliding with another enabled course routing in the same server (PROJ-3 cross-course)', () => {
        testDb = createTestDatabase()
        const { orgA, projectA } = seedTwoOrganizations(testDb)
        expectOk(
          courses.createCourse(
            orgA,
            courseInput(projectA.id, {
              title: 'Data Science',
              adminsRole: 'admins-ds-fa26',
              studentsRole: 'students-ds-fa26',
              categories: [{ name: 'DS GLOBAL', channels: [] }],
            }),
            testDb.db
          )
        )
        const webDesign = expectOk(
          courses.createCourse(
            orgA,
            courseInput(projectA.id, { enabled: true, categories: [] }),
            testDb.db
          )
        )

        const result = courses.addCourseCategory(
          orgA,
          webDesign.id,
          'DS GLOBAL',
          testDb.db
        )

        expect(result?.ok).toBe(false)
        if (result?.ok !== false) throw new Error('expected a conflict')
        expect(result.conflict).toMatchObject({
          field: 'category',
          name: 'DS GLOBAL',
          conflictingCourseTitle: 'Data Science',
        })
      })

      it('returns undefined for a foreign-organization courseId (TEN-2)', () => {
        testDb = createTestDatabase()
        const { orgB, course } = (() => {
          const seeded = seedTwoOrganizations(testDb)
          const created = expectOk(
            courses.createCourse(
              seeded.orgA,
              courseInput(seeded.projectA.id),
              testDb.db
            )
          )
          return { orgB: seeded.orgB, course: created }
        })()

        expect(
          courses.addCourseCategory(orgB, course.id, 'X', testDb.db)
        ).toBeUndefined()
      })
    })

    describe('renameCourseCategory', () => {
      it('renames the one category, leaving its channels and every sibling category untouched', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const target = course.categories[0]!
        const sibling = course.categories[1]!

        const result = courses.renameCourseCategory(
          orgA,
          target.id,
          'GLOBAL RENAMED',
          testDb.db
        )
        if (!result?.ok) throw new Error('expected ok')
        expect(result.category.name).toBe('GLOBAL RENAMED')
        expect(result.category.channels).toEqual(target.channels)

        const fetched = courses.getCourse(orgA, course.id, testDb.db)
        expect(fetched?.categories.find((c) => c.id === sibling.id)).toEqual(
          sibling
        )
      })

      it('does not refuse renaming a category to its own current name', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const target = course.categories[0]!

        const result = courses.renameCourseCategory(
          orgA,
          target.id,
          target.name,
          testDb.db
        )

        expect(result?.ok).toBe(true)
      })

      it('refuses a rename that collides with a sibling category name (PROJ-3 self-conflict)', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const target = course.categories[0]!
        const sibling = course.categories[1]!

        const result = courses.renameCourseCategory(
          orgA,
          target.id,
          sibling.name,
          testDb.db
        )

        expect(result?.ok).toBe(false)
        if (result?.ok !== false) throw new Error('expected a conflict')
        expect(result.conflict.field).toBe('category')
        // Refused before any write — the original name is still there.
        expect(
          courses.getCourse(orgA, course.id, testDb.db)?.categories[0]?.name
        ).toBe(target.name)
      })

      it('returns undefined for a foreign-organization categoryId (TEN-2)', () => {
        testDb = createTestDatabase()
        const { orgB } = seedTwoOrganizations(testDb)
        const { course } = seedCourseWithTwoCategories(testDb)

        expect(
          courses.renameCourseCategory(
            orgB,
            course.categories[0]!.id,
            'X',
            testDb.db
          )
        ).toBeUndefined()
      })
    })

    describe('removeCourseCategory', () => {
      it('removes the category and every channel declared inside it, reporting how many channels went with it', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const target = course.categories[1]! // 'WEEK 1', one channel
        const sibling = course.categories[0]!

        const result = courses.removeCourseCategory(orgA, target.id, testDb.db)

        expect(result).toEqual({ removedChannelCount: 1 })
        const fetched = courses.getCourse(orgA, course.id, testDb.db)
        expect(fetched?.categories.map((c) => c.id)).toEqual([sibling.id])
      })

      it('leaves every other category and channel of the course untouched', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const target = course.categories[0]!
        const sibling = course.categories[1]!

        courses.removeCourseCategory(orgA, target.id, testDb.db)

        const fetched = courses.getCourse(orgA, course.id, testDb.db)
        expect(fetched?.categories).toEqual([sibling])
      })

      it('returns undefined for a foreign-organization categoryId (TEN-2)', () => {
        testDb = createTestDatabase()
        const { orgB } = seedTwoOrganizations(testDb)
        const { course } = seedCourseWithTwoCategories(testDb)

        expect(
          courses.removeCourseCategory(
            orgB,
            course.categories[0]!.id,
            testDb.db
          )
        ).toBeUndefined()
      })
    })

    describe('addCourseChannel', () => {
      it('appends within the category, ordering = max + 1, leaving other channels and categories untouched', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const target = course.categories[0]!
        const sibling = course.categories[1]!

        const channel = courses.addCourseChannel(
          orgA,
          target.id,
          { name: 'questions', adminsOnly: false },
          testDb.db
        )

        expect(channel).toMatchObject({
          name: 'questions',
          adminsOnly: false,
          ordering: 1,
        })
        const fetched = courses.getCourse(orgA, course.id, testDb.db)
        expect(
          fetched?.categories.find((c) => c.id === target.id)?.channels
        ).toEqual([target.channels[0], channel])
        expect(fetched?.categories.find((c) => c.id === sibling.id)).toEqual(
          sibling
        )
      })

      it('returns undefined for a foreign-organization categoryId (TEN-2)', () => {
        testDb = createTestDatabase()
        const { orgB } = seedTwoOrganizations(testDb)
        const { course } = seedCourseWithTwoCategories(testDb)

        expect(
          courses.addCourseChannel(
            orgB,
            course.categories[0]!.id,
            { name: 'x', adminsOnly: false },
            testDb.db
          )
        ).toBeUndefined()
      })
    })

    describe('updateCourseChannel', () => {
      it('changing only adminsOnly leaves the name alone', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const channel = course.categories[0]!.channels[0]!
        expect(channel.adminsOnly).toBe(true)

        const updated = courses.updateCourseChannel(
          orgA,
          channel.id,
          { adminsOnly: false },
          testDb.db
        )

        expect(updated).toMatchObject({
          name: channel.name,
          adminsOnly: false,
        })
      })

      it('changing only name leaves adminsOnly alone', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const channel = course.categories[0]!.channels[0]!

        const updated = courses.updateCourseChannel(
          orgA,
          channel.id,
          { name: 'renamed' },
          testDb.db
        )

        expect(updated).toMatchObject({
          name: 'renamed',
          adminsOnly: channel.adminsOnly,
        })
      })

      it('leaves every other channel and category untouched', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const channel = course.categories[0]!.channels[0]!
        const sibling = course.categories[1]!

        courses.updateCourseChannel(
          orgA,
          channel.id,
          { name: 'renamed' },
          testDb.db
        )

        const fetched = courses.getCourse(orgA, course.id, testDb.db)
        expect(fetched?.categories.find((c) => c.id === sibling.id)).toEqual(
          sibling
        )
      })

      it('returns undefined for a foreign-organization channelId (TEN-2)', () => {
        testDb = createTestDatabase()
        const { orgB } = seedTwoOrganizations(testDb)
        const { course } = seedCourseWithTwoCategories(testDb)

        expect(
          courses.updateCourseChannel(
            orgB,
            course.categories[0]!.channels[0]!.id,
            { name: 'x' },
            testDb.db
          )
        ).toBeUndefined()
      })
    })

    describe('removeCourseChannel', () => {
      it('removes only the one channel, leaving its category and every sibling channel/category untouched', () => {
        testDb = createTestDatabase()
        const { orgA, course } = seedCourseWithTwoCategories(testDb)
        const target = course.categories[0]!.channels[0]!
        const sibling = course.categories[1]!

        const removed = courses.removeCourseChannel(orgA, target.id, testDb.db)

        expect(removed).toBe(true)
        const fetched = courses.getCourse(orgA, course.id, testDb.db)
        expect(
          fetched?.categories.find((c) => c.id === course.categories[0]!.id)
            ?.channels
        ).toEqual([])
        expect(fetched?.categories.find((c) => c.id === sibling.id)).toEqual(
          sibling
        )
      })

      it('returns false for a foreign-organization channelId (TEN-2)', () => {
        testDb = createTestDatabase()
        const { orgB } = seedTwoOrganizations(testDb)
        const { course } = seedCourseWithTwoCategories(testDb)

        expect(
          courses.removeCourseChannel(
            orgB,
            course.categories[0]!.channels[0]!.id,
            testDb.db
          )
        ).toBe(false)
      })
    })
  })
})
