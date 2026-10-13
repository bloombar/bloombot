/**
 * TEN-11 — a course that uses no Discord (`courses.discordEnabled` false).
 *
 * Each case pins one place the flag has to be respected in the data layer:
 * the stored shape, routing, PROJ-3 name checks (both directions), the
 * TEN-9 enablement refusals, the second-binding backfill, and that stored
 * roles and categories survive Discord being turned off and back on.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  courses,
  discordServers,
  organizations,
  projects,
} from '@bloombot/db'
import type { courses as coursesRepo } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function seed(testDatabase: TestDatabase) {
  const orgId = randomUUID()
  organizations.createOrganization(
    orgId,
    { name: 'Org', isPersonal: false },
    testDatabase.db
  )
  const project = projects.createProject(
    orgId,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const installer = accounts.createAccount(
    orgId,
    { email: 'installer@example.edu', displayName: 'I', role: 'owner' },
    testDatabase.db
  )
  return { orgId, project, installer }
}

function bind(
  testDatabase: TestDatabase,
  orgId: string,
  installerId: string,
  serverId: string
) {
  const binding = discordServers.claimDiscordServerBinding(
    orgId,
    { serverId, installedByAccountId: installerId },
    testDatabase.db
  )
  if (!binding) throw new Error('claim refused')
  return binding
}

function input(
  projectId: string,
  overrides: Partial<coursesRepo.NewCourse> = {}
): coursesRepo.NewCourse {
  return {
    projectId,
    title: 'Web Design',
    enabled: true,
    adminsRole: 'admins',
    studentsRole: 'students',
    categories: [{ name: 'GLOBAL', channels: [] }],
    ...overrides,
  }
}

function ok(result: coursesRepo.SaveCourseResult | undefined) {
  if (!result || !result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  }
  return result.course
}

describe('courses without Discord (TEN-11)', () => {
  it('stores discordEnabled, defaulting to true when omitted', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)

    const on = ok(courses.createCourse(orgId, input(project.id), testDb.db))
    const off = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          title: 'Off',
          enabled: false,
          discordEnabled: false,
        }),
        testDb.db
      )
    )

    expect(on.discordEnabled).toBe(true)
    expect(off.discordEnabled).toBe(false)
  })

  it('drops a server id sent alongside discordEnabled false', () => {
    testDb = createTestDatabase()
    const { orgId, project, installer } = seed(testDb)
    const server = bind(testDb, orgId, installer.id, '404040404040404001')

    const created = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          discordEnabled: false,
          discordServerId: server.serverId,
        }),
        testDb.db
      )
    )
    expect(created.discordServerId).toBeNull()

    const withServer = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          title: 'On',
          adminsRole: 'a2',
          studentsRole: 's2',
          categories: [],
          discordServerId: server.serverId,
        }),
        testDb.db
      )
    )
    const updated = ok(
      courses.updateCourse(
        orgId,
        withServer.id,
        input(project.id, {
          title: 'On',
          adminsRole: 'a2',
          studentsRole: 's2',
          categories: [],
          discordEnabled: false,
          discordServerId: server.serverId,
        }),
        testDb.db
      )
    )
    expect(updated.discordEnabled).toBe(false)
    expect(updated.discordServerId).toBeNull()
  })

  it('is excluded from the routable-course list by flag, even when its categories match', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    const off = ok(
      courses.createCourse(
        orgId,
        input(project.id, { discordEnabled: false }),
        testDb.db
      )
    )

    const rows = courses.listRoutableCourses(orgId, testDb.db)
    const row = rows.find((r) => r.id === off.id)
    // The row is still listed (the caller filters), carrying the flag and the
    // stored names so turning Discord on restores routing.
    expect(row?.discordEnabled).toBe(false)
    expect(row?.categoryNames).toEqual(['GLOBAL'])
  })

  it('takes no part in PROJ-3 checks as a candidate', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    ok(
      courses.createCourse(
        orgId,
        input(project.id, { title: 'Off', discordEnabled: false }),
        testDb.db
      )
    )

    // Same roles and category as the discord-off course above.
    const result = courses.createCourse(
      orgId,
      input(project.id, { title: 'On' }),
      testDb.db
    )
    expect(result.ok).toBe(true)
  })

  it('takes no part in PROJ-3 checks as the course being checked', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    ok(courses.createCourse(orgId, input(project.id), testDb.db))

    const result = courses.createCourse(
      orgId,
      input(project.id, { title: 'Off', discordEnabled: false }),
      testDb.db
    )
    expect(result.ok).toBe(true)
  })

  it('still refuses the same collision when both courses use Discord', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    ok(courses.createCourse(orgId, input(project.id), testDb.db))

    const result = courses.createCourse(
      orgId,
      input(project.id, { title: 'Second' }),
      testDb.db
    )
    expect(result.ok).toBe(false)
  })

  it('enables a discord-off course in a two-binding organization (no server refusal)', () => {
    testDb = createTestDatabase()
    const { orgId, project, installer } = seed(testDb)
    bind(testDb, orgId, installer.id, '404040404040404011')
    bind(testDb, orgId, installer.id, '404040404040404012')

    const created = ok(
      courses.createCourse(
        orgId,
        input(project.id, { enabled: false, discordEnabled: false }),
        testDb.db
      )
    )
    const enabled = courses.enableCourse(orgId, created.id, testDb.db)
    expect(enabled).toEqual({ ok: true, changed: true })

    // And a save of an enabled one is not refused either.
    const saved = courses.createCourse(
      orgId,
      input(project.id, {
        title: 'Saved',
        adminsRole: 'x',
        studentsRole: 'y',
        discordEnabled: false,
      }),
      testDb.db
    )
    expect(saved.ok).toBe(true)

    // Control: the same save for a Discord course is refused as ambiguous.
    const control = courses.createCourse(
      orgId,
      input(project.id, {
        title: 'Control',
        adminsRole: 'p',
        studentsRole: 'q',
      }),
      testDb.db
    )
    expect(control.ok).toBe(false)
  })

  it('is left alone by the second-binding backfill, while a Discord course is pinned', () => {
    testDb = createTestDatabase()
    const { orgId, project, installer } = seed(testDb)
    const first = bind(testDb, orgId, installer.id, '404040404040404021')
    const on = ok(
      courses.createCourse(
        orgId,
        input(project.id, { title: 'On', enabled: false }),
        testDb.db
      )
    )
    const off = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          title: 'Off',
          enabled: false,
          discordEnabled: false,
        }),
        testDb.db
      )
    )

    bind(testDb, orgId, installer.id, '404040404040404022')

    expect(courses.getCourse(orgId, on.id, testDb.db)?.discordServerId).toBe(
      first.serverId
    )
    const reloadedOff = courses.getCourse(orgId, off.id, testDb.db)
    expect(reloadedOff?.discordServerId).toBeNull()
    expect(reloadedOff?.discordEnabled).toBe(false)
  })

  it('keeps stored roles and categories when Discord is turned off and back on', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    const created = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          categories: [
            { name: 'GLOBAL', channels: [{ name: 'news', adminsOnly: false }] },
          ],
        }),
        testDb.db
      )
    )

    const settings = (
      discordEnabled: boolean
    ): coursesRepo.CourseSettingsUpdate => ({
      title: created.title,
      enabled: created.enabled,
      adminsRole: created.adminsRole,
      studentsRole: created.studentsRole,
      model: null,
      vectorStoreId: null,
      maxRequestsPerDay: null,
      conversationScope: created.conversationScope,
      selfEnrolFromDiscord: false,
      answerUnenrolled: true,
      discordServerId: null,
      discordEnabled,
    })

    const off = ok(
      courses.updateCourseSettings(
        orgId,
        created.id,
        settings(false),
        testDb.db
      )
    )
    expect(off.discordEnabled).toBe(false)
    expect(off.adminsRole).toBe('admins')
    expect(off.categories.map((c) => c.name)).toEqual(['GLOBAL'])

    const back = ok(
      courses.updateCourseSettings(orgId, created.id, settings(true), testDb.db)
    )
    expect(back.discordEnabled).toBe(true)
    expect(back.studentsRole).toBe('students')
    expect(back.categories[0]?.channels.map((c) => c.name)).toEqual(['news'])
  })

  it('refuses turning Discord back on into a collision with a Discord course', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    ok(courses.createCourse(orgId, input(project.id), testDb.db))
    const off = ok(
      courses.createCourse(
        orgId,
        input(project.id, { title: 'Off', discordEnabled: false }),
        testDb.db
      )
    )

    const result = courses.updateCourse(
      orgId,
      off.id,
      input(project.id, { title: 'Off', discordEnabled: true }),
      testDb.db
    )
    expect(result?.ok).toBe(false)
  })
  // Rework round 1 — guards the review found untested.

  /** A full `CourseSettingsUpdate` from a stored course, overridable. */
  function settingsFor(
    course: coursesRepo.Course,
    overrides: Partial<coursesRepo.CourseSettingsUpdate> = {}
  ): coursesRepo.CourseSettingsUpdate {
    return {
      title: course.title,
      enabled: course.enabled,
      adminsRole: course.adminsRole,
      studentsRole: course.studentsRole,
      model: null,
      vectorStoreId: null,
      maxRequestsPerDay: null,
      conversationScope: course.conversationScope,
      selfEnrolFromDiscord: false,
      answerUnenrolled: true,
      discordServerId: null,
      discordEnabled: course.discordEnabled,
      ...overrides,
    }
  }

  it('edits an enabled discord-off course in a two-binding organization without an ambiguity refusal', () => {
    testDb = createTestDatabase()
    const { orgId, project, installer } = seed(testDb)
    bind(testDb, orgId, installer.id, '404040404040404031')
    bind(testDb, orgId, installer.id, '404040404040404032')
    const created = ok(
      courses.createCourse(
        orgId,
        input(project.id, { discordEnabled: false }),
        testDb.db
      )
    )

    const viaSave = courses.updateCourse(
      orgId,
      created.id,
      input(project.id, { title: 'Renamed', discordEnabled: false }),
      testDb.db
    )
    expect(viaSave?.ok).toBe(true)

    const viaSettings = courses.updateCourseSettings(
      orgId,
      created.id,
      settingsFor(created, { title: 'Renamed again' }),
      testDb.db
    )
    expect(viaSettings?.ok).toBe(true)
  })

  it('refuses turning Discord on when the role names clash with a Discord course, even if nothing else changed', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    // A uses the roles; B (off) shares them but not the categories.
    ok(courses.createCourse(orgId, input(project.id), testDb.db))
    const b = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          title: 'B',
          discordEnabled: false,
          categories: [{ name: 'B-ONLY', channels: [] }],
        }),
        testDb.db
      )
    )

    const viaSave = courses.updateCourse(
      orgId,
      b.id,
      input(project.id, {
        title: 'B',
        discordEnabled: true,
        categories: [{ name: 'B-ONLY', channels: [] }],
      }),
      testDb.db
    )
    expect(viaSave?.ok).toBe(false)
    if (viaSave && !viaSave.ok) {
      expect(['adminsRole', 'studentsRole']).toContain(viaSave.conflict.field)
    }

    const viaSettings = courses.updateCourseSettings(
      orgId,
      b.id,
      settingsFor(b, { discordEnabled: true }),
      testDb.db
    )
    expect(viaSettings?.ok).toBe(false)
  })

  it('re-checks the within-course role clash when Discord is turned back on', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    // Admins "TA" and students "ta" are the same Discord role.
    const off = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          discordEnabled: false,
          adminsRole: 'TA',
          studentsRole: 'ta',
        }),
        testDb.db
      )
    )

    const viaSave = courses.updateCourse(
      orgId,
      off.id,
      input(project.id, {
        discordEnabled: true,
        adminsRole: 'TA',
        studentsRole: 'ta',
      }),
      testDb.db
    )
    expect(viaSave?.ok).toBe(false)

    const viaSettings = courses.updateCourseSettings(
      orgId,
      off.id,
      settingsFor(off, { discordEnabled: true }),
      testDb.db
    )
    expect(viaSettings?.ok).toBe(false)
  })

  it('unarchives a project holding an enabled discord-off course in a two-binding organization', () => {
    testDb = createTestDatabase()
    const { orgId, project, installer } = seed(testDb)
    bind(testDb, orgId, installer.id, '404040404040404041')
    bind(testDb, orgId, installer.id, '404040404040404042')
    ok(
      courses.createCourse(
        orgId,
        input(project.id, { discordEnabled: false }),
        testDb.db
      )
    )
    projects.archiveProject(orgId, project.id, testDb.db)

    const result = projects.unarchiveProject(orgId, project.id, testDb.db)
    expect(result?.ok).toBe(true)
  })

  it('accepts a category on a discord-off course even when a Discord course already uses that name', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    ok(courses.createCourse(orgId, input(project.id), testDb.db))
    const off = ok(
      courses.createCourse(
        orgId,
        input(project.id, {
          title: 'Off',
          adminsRole: 'x',
          studentsRole: 'y',
          discordEnabled: false,
          categories: [],
        }),
        testDb.db
      )
    )

    const added = courses.addCourseCategory(orgId, off.id, 'GLOBAL', testDb.db)
    expect(added?.ok).toBe(true)
  })

  it('accepts duplicate category names within a discord-off course, but not within a Discord one', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    const dup = [
      { name: 'Week 1', channels: [] },
      { name: 'week 1', channels: [] },
    ]

    const off = courses.createCourse(
      orgId,
      input(project.id, { discordEnabled: false, categories: dup }),
      testDb.db
    )
    expect(off.ok).toBe(true)

    const on = courses.createCourse(
      orgId,
      input(project.id, {
        title: 'On',
        adminsRole: 'p',
        studentsRole: 'q',
        categories: dup,
      }),
      testDb.db
    )
    expect(on.ok).toBe(false)
  })
  it('accepts clashing roles and duplicate categories when updating a discord-off course', () => {
    testDb = createTestDatabase()
    const { orgId, project } = seed(testDb)
    const off = ok(
      courses.createCourse(
        orgId,
        input(project.id, { discordEnabled: false }),
        testDb.db
      )
    )

    const viaSave = courses.updateCourse(
      orgId,
      off.id,
      input(project.id, {
        discordEnabled: false,
        adminsRole: 'TA',
        studentsRole: 'ta',
        categories: [
          { name: 'Week 1', channels: [] },
          { name: 'week 1', channels: [] },
        ],
      }),
      testDb.db
    )
    expect(viaSave?.ok).toBe(true)

    const viaSettings = courses.updateCourseSettings(
      orgId,
      off.id,
      settingsFor(off, { adminsRole: 'Staff', studentsRole: 'staff' }),
      testDb.db
    )
    expect(viaSettings?.ok).toBe(true)
  })
})
