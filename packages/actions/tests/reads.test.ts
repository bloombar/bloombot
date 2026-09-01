/**
 * PROJ-5: the control panel reads through the same action layer it writes
 * through. Every read action this slice adds — `projects.list`,
 * `courses.list`, `courses.get`, `discordServers.list` — is exercised
 * through `dispatch` the same way the writes in `actions.test.ts` are, and
 * proven tenant-scoped the same way: a caller cannot see, or name, another
 * organization's record through any of them.
 */

import { courses, discordServers, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  getCourseAction,
  listCoursesAction,
  listDiscordServersAction,
  listProjectsAction,
} from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import {
  seedOrganizationWithBoundServer,
  seedOrganizationWithProject,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('projects.list', () => {
  it("lists the caller's own organization's active projects, excluding archived ones by default", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    const archived = projects.createProject(
      organizationId,
      { name: 'Spring 2026' },
      testDb.db
    )
    projects.archiveProject(organizationId, archived.id, testDb.db)

    const result = await dispatch(
      listProjectsAction,
      {},
      { organizationId, db: testDb.db }
    )

    expect(result.map((p) => p.id)).toEqual([projectId])
  })

  it('includes archived projects when asked', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    const archived = projects.createProject(
      organizationId,
      { name: 'Spring 2026' },
      testDb.db
    )
    projects.archiveProject(organizationId, archived.id, testDb.db)

    const result = await dispatch(
      listProjectsAction,
      { includeArchived: true },
      { organizationId, db: testDb.db }
    )

    expect(result.map((p) => p.id).sort()).toEqual(
      [
        ...projects
          .listProjects(organizationId, testDb.db, { includeArchived: false })
          .map((p) => p.id),
        archived.id,
      ].sort()
    )
  })

  it("does not include another organization's projects", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(
      testDb.db,
      'Org A Term'
    )
    seedOrganizationWithProject(testDb.db, 'Org B Term')

    const result = await dispatch(
      listProjectsAction,
      {},
      { organizationId: orgA, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('Org A Term')
  })
})

describe('courses.list', () => {
  it("lists a project's own courses", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      listCoursesAction,
      { projectId },
      { organizationId, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: created.course.id,
      title: 'Web Design',
    })
  })

  it("refuses another organization's project, the same way a write does", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { projectId: projectBId } = seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        listCoursesAction,
        { projectId: projectBId },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('courses.get', () => {
  it('opens one course, with its categories and channels', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [
          {
            name: 'GLOBAL',
            channels: [{ name: 'chat', adminsOnly: false }],
          },
        ],
      },
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      getCourseAction,
      { courseId: created.course.id },
      { organizationId, db: testDb.db }
    )

    expect(result.title).toBe('Web Design')
    expect(result.categories).toHaveLength(1)
    expect(result.categories[0]?.channels).toHaveLength(1)
    expect(result.categories[0]?.channels[0]?.name).toBe('chat')
  })

  it("refuses another organization's course, the same way a write does", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)
    const courseB = courses.createCourse(
      orgB,
      {
        projectId: projectBId,
        title: 'Org B Course',
        filePrefix: 'ob',
        enabled: true,
        adminsRole: 'admins-ob',
        studentsRole: 'students-ob',
        categories: [],
      },
      testDb.db
    )
    if (!courseB.ok) throw new Error('setup failed: unexpected conflict')

    await expect(
      dispatch(
        getCourseAction,
        { courseId: courseB.course.id },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('discordServers.list', () => {
  it("lists the caller's own organization's bindings, not another organization's", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, serverId: serverA } =
      seedOrganizationWithBoundServer(testDb.db, 'Org A')
    seedOrganizationWithBoundServer(testDb.db, 'Org B')

    const result = await dispatch(
      listDiscordServersAction,
      {},
      { organizationId: orgA, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.serverId).toBe(serverA)
  })

  // TEN-8: "a removed binding is shown as removed rather than omitted" —
  // see `docs/DECISIONS.md` for why this slice chose to show it.
  it('shows a removed binding as removed, not omitted', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )
    discordServers.removeDiscordServerBinding(
      organizationId,
      serverId,
      testDb.db
    )

    const result = await dispatch(
      listDiscordServersAction,
      {},
      { organizationId, db: testDb.db }
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.serverId).toBe(serverId)
    expect(result[0]?.removedAt).not.toBeNull()
  })
})
