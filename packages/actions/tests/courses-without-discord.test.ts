/**
 * TEN-11 — `discordEnabled` through the actions: `courses.save` and
 * `courses.updateSettings` (default, keep, clear), the course export/import
 * round trip, and project duplication.
 */

import { accounts, courses, discordServers, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  duplicateProjectAction,
  exportCourseAction,
  scaffoldDiscordServerAction,
  importCourseAction,
  saveCourseAction,
  updateSettingsCourseAction,
} from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { ActionConflictError } from '../src/errors.js'
import {
  seedOrganizationWithBoundServer,
  seedOrganizationWithProject,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function saveInput(projectId: string, extra: Record<string, unknown> = {}) {
  return {
    projectId,
    title: 'Web Design',
    enabled: false,
    adminsRole: 'admins-wd',
    studentsRole: 'students-wd',
    categories: [],
    ...extra,
  }
}

describe('courses.save and discordEnabled (TEN-11)', () => {
  it('defaults to true on create when omitted, for callers that predate the field', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)

    const course = await dispatch(saveCourseAction, saveInput(projectId), {
      organizationId,
      db: testDb.db,
    })

    expect(course.discordEnabled).toBe(true)
  })

  it('stores false and drops a server id sent with it', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )
    const project = projects.createProject(
      organizationId,
      { name: 'Fall' },
      testDb.db
    )

    const course = await dispatch(
      saveCourseAction,
      saveInput(project.id, {
        discordEnabled: false,
        discordServerId: serverId,
      }),
      { organizationId, db: testDb.db }
    )

    expect(course.discordEnabled).toBe(false)
    expect(course.discordServerId).toBeNull()
  })

  it('keeps the stored value when omitted on update, and changes it when sent', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const created = await dispatch(
      saveCourseAction,
      saveInput(projectId, { discordEnabled: false }),
      { organizationId, db: testDb.db }
    )

    const kept = await dispatch(
      saveCourseAction,
      saveInput(projectId, { id: created.id, title: 'Renamed' }),
      { organizationId, db: testDb.db }
    )
    expect(kept.discordEnabled).toBe(false)

    const turnedOn = await dispatch(
      saveCourseAction,
      saveInput(projectId, { id: created.id, discordEnabled: true }),
      { organizationId, db: testDb.db }
    )
    expect(turnedOn.discordEnabled).toBe(true)
  })
})

describe('courses.updateSettings and discordEnabled (TEN-11)', () => {
  async function seedCourse(discordEnabled: boolean) {
    const seeded = seedOrganizationWithBoundServer(testDb.db)
    const project = projects.createProject(
      seeded.organizationId,
      { name: 'Fall' },
      testDb.db
    )
    const course = await dispatch(
      saveCourseAction,
      saveInput(project.id, {
        discordEnabled,
        ...(discordEnabled ? { discordServerId: seeded.serverId } : {}),
      }),
      { organizationId: seeded.organizationId, db: testDb.db }
    )
    return { ...seeded, course }
  }

  it('keeps the stored value when omitted', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = await seedCourse(false)

    const updated = await dispatch(
      updateSettingsCourseAction,
      { id: course.id, title: 'Renamed' },
      { organizationId, db: testDb.db }
    )

    expect(updated.discordEnabled).toBe(false)
  })

  it('turning it off clears the server but keeps roles and categories', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = await seedCourse(true)
    expect(course.discordServerId).not.toBeNull()

    const updated = await dispatch(
      updateSettingsCourseAction,
      { id: course.id, discordEnabled: false },
      { organizationId, db: testDb.db }
    )

    expect(updated.discordEnabled).toBe(false)
    expect(updated.discordServerId).toBeNull()
    expect(updated.adminsRole).toBe('admins-wd')
  })

  it('naming a server on a no-Discord course turns Discord on', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId, course } = await seedCourse(false)

    const updated = await dispatch(
      updateSettingsCourseAction,
      { id: course.id, discordServerId: serverId },
      { organizationId, db: testDb.db }
    )

    expect(updated.discordEnabled).toBe(true)
    expect(updated.discordServerId).toBe(serverId)
  })
})

describe('course portability and duplication (TEN-11)', () => {
  it('round-trips discordEnabled false through export and import', async () => {
    testDb = createTestDatabase()
    const source = seedOrganizationWithProject(testDb.db, 'Fall')
    const course = await dispatch(
      saveCourseAction,
      saveInput(source.projectId, { discordEnabled: false }),
      { organizationId: source.organizationId, db: testDb.db }
    )
    const exported = await dispatch(
      exportCourseAction,
      { courseId: course.id },
      { organizationId: source.organizationId, db: testDb.db }
    )
    expect(exported.content).toContain('discordEnabled: false')

    const destination = seedOrganizationWithProject(testDb.db, 'Spring')
    const importer = accounts.createAccount(
      destination.organizationId,
      { email: 'importer@example.edu', displayName: 'I', role: 'owner' },
      testDb.db
    )
    const imported = await dispatch(
      importCourseAction,
      { projectId: destination.projectId, content: exported.content },
      {
        organizationId: destination.organizationId,
        db: testDb.db,
        accountId: importer.id,
      }
    )

    expect(imported.course.discordEnabled).toBe(false)
  })

  it('imports a file that predates the field as using Discord', async () => {
    testDb = createTestDatabase()
    const source = seedOrganizationWithProject(testDb.db, 'Fall')
    const course = await dispatch(
      saveCourseAction,
      saveInput(source.projectId),
      { organizationId: source.organizationId, db: testDb.db }
    )
    const exported = await dispatch(
      exportCourseAction,
      { courseId: course.id },
      { organizationId: source.organizationId, db: testDb.db }
    )
    const oldFile = exported.content.replace(/^\s*discordEnabled: .*\n/m, '')
    expect(oldFile).not.toContain('discordEnabled')

    const destination = seedOrganizationWithProject(testDb.db, 'Spring')
    const importer = accounts.createAccount(
      destination.organizationId,
      { email: 'importer2@example.edu', displayName: 'I', role: 'owner' },
      testDb.db
    )
    const imported = await dispatch(
      importCourseAction,
      { projectId: destination.projectId, content: oldFile },
      {
        organizationId: destination.organizationId,
        db: testDb.db,
        accountId: importer.id,
      }
    )

    expect(imported.course.discordEnabled).toBe(true)
  })

  it('carries discordEnabled false onto a duplicated project', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    await dispatch(
      saveCourseAction,
      saveInput(projectId, { discordEnabled: false }),
      { organizationId, db: testDb.db }
    )

    const result = await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    const copies = courses.listCourses(organizationId, testDb.db, {
      projectId: result.project.id,
    })
    expect(copies).toHaveLength(1)
    expect(copies[0]?.discordEnabled).toBe(false)
  })
})

describe('a stale server id and discordEnabled false (TEN-11)', () => {
  it('courses.save accepts a removed binding id when Discord is turned off, and drops it', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )
    const project = projects.createProject(
      organizationId,
      { name: 'Fall' },
      testDb.db
    )
    discordServers.removeDiscordServerBinding(
      organizationId,
      serverId,
      testDb.db
    )

    const course = await dispatch(
      saveCourseAction,
      saveInput(project.id, {
        discordEnabled: false,
        discordServerId: serverId,
      }),
      { organizationId, db: testDb.db }
    )

    expect(course.discordEnabled).toBe(false)
    expect(course.discordServerId).toBeNull()
  })

  it('courses.updateSettings accepts a removed binding id when Discord is turned off', async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )
    const project = projects.createProject(
      organizationId,
      { name: 'Fall' },
      testDb.db
    )
    const created = await dispatch(
      saveCourseAction,
      saveInput(project.id, { discordServerId: serverId }),
      { organizationId, db: testDb.db }
    )
    discordServers.removeDiscordServerBinding(
      organizationId,
      serverId,
      testDb.db
    )

    const updated = await dispatch(
      updateSettingsCourseAction,
      { id: created.id, discordEnabled: false, discordServerId: serverId },
      { organizationId, db: testDb.db }
    )

    expect(updated.discordEnabled).toBe(false)
    expect(updated.discordServerId).toBeNull()
  })
})

describe('discordServers.scaffold and a course with no Discord (TEN-11)', () => {
  it('refuses up front instead of queueing a job', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = await dispatch(
      saveCourseAction,
      saveInput(projectId, { discordEnabled: false }),
      { organizationId, db: testDb.db }
    )

    const countJobs = () =>
      (
        testDb.db.$client
          .prepare('select count(*) as n from jobs where kind = ?')
          .get('discordServers.scaffold') as { n: number }
      ).n
    await expect(
      dispatch(
        scaffoldDiscordServerAction,
        { courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionConflictError)
    expect(countJobs()).toBe(0)
  })

  it('still queues a job for a course that uses Discord', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = await dispatch(saveCourseAction, saveInput(projectId), {
      organizationId,
      db: testDb.db,
    })

    const result = await dispatch(
      scaffoldDiscordServerAction,
      { courseId: course.id },
      { organizationId, db: testDb.db }
    )
    expect(result.jobId).toBeTruthy()
  })
})
