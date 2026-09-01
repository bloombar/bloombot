import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { courses, organizations, projects, schema } from '@bloombot/db'
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
    filePrefix: 'wd',
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
})
