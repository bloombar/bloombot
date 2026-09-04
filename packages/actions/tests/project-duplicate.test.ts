/**
 * `projects.duplicate` (PROJ-4): copies a project's courses, categories,
 * channels, instructions and settings into a new project, leaves the source
 * project and its rosters/transcripts untouched, and asserts the PROJ-3
 * decision this slice made (`docs/DECISIONS.md`) — every copied course is
 * created disabled, including the case that would otherwise collide.
 */

import {
  conversations,
  courses,
  courseWebSources,
  people,
  projects,
} from '@bloombot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { duplicateProjectAction } from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { ActionConflictError, ActionRefusedError } from '../src/errors.js'
import {
  seedOrganizationWithBoundServer,
  seedOrganizationWithProject,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('projects.duplicate', () => {
  it("brings a project's courses, categories, channels, instructions and settings into the new project", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    const source = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd-fa26',
        studentsRole: 'students-wd-fa26',
        promptId: 'prompt-1',
        instructions: 'Be helpful.',
        model: 'gpt-5',
        vectorStoreId: 'vs-1',
        maxRequestsPerDay: 50,
        conversationScope: 'course_surface',
        categories: [
          {
            name: 'Web Design - GLOBAL',
            channels: [
              { name: 'chat', adminsOnly: false },
              { name: 'staff', adminsOnly: true },
            ],
          },
        ],
      },
      testDb.db
    )
    if (!source.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    expect(result.project).toMatchObject({
      organizationId,
      name: 'Spring 2027',
      archivedAt: null,
    })
    // Finding 7 (rework pass): the result names how many courses were
    // copied and that they are all disabled, rather than leaving the caller
    // to issue a second `courses.list` to find out.
    expect(result.coursesCopied).toBe(1)
    expect(result.coursesDisabled).toBe(true)

    const copiedCourses = courses.listCourses(organizationId, testDb.db, {
      projectId: result.project.id,
    })
    expect(copiedCourses).toHaveLength(1)
    const copied = courses.getCourse(
      organizationId,
      copiedCourses[0]!.id,
      testDb.db
    )
    expect(copied).toMatchObject({
      title: 'Web Design',
      filePrefix: 'wd',
      adminsRole: 'admins-wd-fa26',
      studentsRole: 'students-wd-fa26',
      promptId: 'prompt-1',
      instructions: 'Be helpful.',
      model: 'gpt-5',
      vectorStoreId: 'vs-1',
      maxRequestsPerDay: 50,
      conversationScope: 'course_surface',
    })
    expect(copied?.categories).toHaveLength(1)
    expect(copied?.categories[0]?.name).toBe('Web Design - GLOBAL')
    expect(copied?.categories[0]?.channels.map((c) => c.name).sort()).toEqual(
      ['chat', 'staff'].sort()
    )

    // The source project and its own course are unchanged.
    expect(
      projects.getProject(organizationId, projectId, testDb.db)
    ).toMatchObject({ name: 'Fall 2026', archivedAt: null })
    expect(
      courses.getCourse(organizationId, source.course.id, testDb.db)
    ).toMatchObject({ title: 'Web Design', enabled: true })
  })

  // PROJ-3 decision (`docs/DECISIONS.md`): a copied course carries the same
  // category and role names as its original — exactly the collision PROJ-3
  // forbids among enabled courses — so it is created disabled regardless.
  it('copies every course disabled, even one that was enabled in the source project', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const source = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [{ name: 'GLOBAL', channels: [] }],
      },
      testDb.db
    )
    if (!source.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Copy of Fall 2026' },
      { organizationId, db: testDb.db }
    )

    const copiedCourses = courses.listCourses(organizationId, testDb.db, {
      projectId: result.project.id,
    })
    expect(copiedCourses).toHaveLength(1)
    expect(copiedCourses[0]?.enabled).toBe(false)

    // The exact case that would have collided: the copy's category and role
    // names are identical to the still-enabled source course's — this
    // never reaches PROJ-3's check at all, because the copy is disabled.
    expect(copiedCourses[0]?.adminsRole).toBe('admins-wd')
    expect(
      courses
        .listRoutableCourses(organizationId, testDb.db)
        .filter((c) => c.id === copiedCourses[0]?.id)
    ).toHaveLength(1) // present, but...
    expect(
      courses
        .listRoutableCourses(organizationId, testDb.db)
        .find((c) => c.id === copiedCourses[0]?.id)?.enabled
    ).toBe(false) // ...not enabled, so it never collides with the source.
  })

  it('does not touch rosters or transcripts', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const source = courses.createCourse(
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
    if (!source.ok) throw new Error('setup failed: unexpected conflict')
    const person = people.createPerson(organizationId, {}, testDb.db)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: source.course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('setup failed: no conversation')
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'from_person', content: 'Hello' },
      testDb.db
    )

    await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    // The source course's conversation and message are exactly as they
    // were — nothing about duplicating a project touches `people`,
    // `conversations` or `messages` at all.
    expect(
      conversations.getOrCreateConversation(
        organizationId,
        { courseId: source.course.id, personId: person.id, surface: 'discord' },
        testDb.db
      )
    ).toMatchObject({ id: conversation.id })
  })

  it('refuses to duplicate a project that does not exist', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        duplicateProjectAction,
        { projectId: 'no-such-project', name: 'Spring 2027' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it("refuses to duplicate another organization's project", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { projectId: projectBId } = seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        duplicateProjectAction,
        { projectId: projectBId, name: 'Spring 2027' },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    // Org B's project is untouched: no new project was created there either.
    expect(
      projects.listProjects(orgA, testDb.db, { includeArchived: true })
    ).toHaveLength(1)
  })

  it('refuses a duplicate name already used by another active project, naming the conflict', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    projects.createProject(organizationId, { name: 'Spring 2027' }, testDb.db)

    const attempt = dispatch(
      duplicateProjectAction,
      { projectId, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    await expect(attempt).rejects.toThrow(ActionConflictError)
    // No orphaned courses were created under a project that was refused.
    expect(courses.listCourses(organizationId, testDb.db, {}).length).toBe(0)
  })

  // Finding 1 (rework pass): a failure partway through used to leave a new
  // project committed with only some of its courses copied — indistinguishable
  // from a complete duplicate — while consuming the chosen name, so a retry
  // under the same name was refused as a collision with the stub the failed
  // attempt left behind. Wrapping the whole duplicate in one transaction
  // (`actions/projects.ts`) rolls all of it back, name included, on any
  // failure — proven here with a real, unrecoverable failure on the *second*
  // course's own write, standing in for the database fault or process crash
  // this fix actually targets.
  it('rolls back the whole duplicate — new project included — when a course partway through fails to copy, freeing the name for a retry', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    for (const suffix of ['A', 'B']) {
      const created = courses.createCourse(
        organizationId,
        {
          projectId,
          title: `Course ${suffix}`,
          filePrefix: suffix.toLowerCase(),
          enabled: false,
          adminsRole: `admins-${suffix.toLowerCase()}`,
          studentsRole: `students-${suffix.toLowerCase()}`,
          categories: [],
        },
        testDb.db
      )
      if (!created.ok) throw new Error('setup failed: unexpected conflict')
    }

    // The first course copies normally; the second fails the way a database
    // fault or a process crash mid-loop would — a real thrown error, not a
    // refusal `duplicateProjectAction` itself produces.
    const realCreateCourse = courses.createCourse
    let calls = 0
    const spy = vi
      .spyOn(courses, 'createCourse')
      .mockImplementation((...args) => {
        calls += 1
        if (calls === 2) throw new Error('simulated database fault')
        return realCreateCourse(...args)
      })

    try {
      await expect(
        dispatch(
          duplicateProjectAction,
          { projectId, name: 'Spring 2027' },
          { organizationId, db: testDb.db }
        )
      ).rejects.toThrow('simulated database fault')
    } finally {
      spy.mockRestore()
    }

    // Not a half-copy sitting under a project that looks complete: the new
    // project itself was rolled back too, so only the original ("Fall 2026")
    // remains.
    expect(
      projects
        .listProjects(organizationId, testDb.db, { includeArchived: true })
        .map((project) => project.name)
    ).toEqual(['Fall 2026'])

    // The name is free again — the obvious recovery (retry under the same
    // name) succeeds instead of being refused as a collision with a stub.
    const retried = await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )
    expect(retried.project.name).toBe('Spring 2027')
    expect(retried.coursesCopied).toBe(2)
  })

  // Finding 2 (rework pass): a source course that could not be re-read used
  // to be silently skipped (`if (!source) continue`) — the duplicate still
  // reported success, indistinguishable from a complete copy. Every other
  // guard in this file throws; this one now does too.
  it('throws, rather than silently continuing, when a listed source course cannot be re-read', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    const created = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: false,
        adminsRole: 'admins-wd',
        studentsRole: 'students-wd',
        categories: [],
      },
      testDb.db
    )
    if (!created.ok) throw new Error('setup failed: unexpected conflict')

    // Stands in for the race the file's own comment already names as
    // "unreachable in practice" — `getCourse` returning `undefined` for a
    // course `listCourses` just listed a moment earlier.
    const spy = vi.spyOn(courses, 'getCourse').mockReturnValue(undefined)

    try {
      await expect(
        dispatch(
          duplicateProjectAction,
          { projectId, name: 'Spring 2027' },
          { organizationId, db: testDb.db }
        )
      ).rejects.toThrow(ActionRefusedError)
    } finally {
      spy.mockRestore()
    }

    // No half-duplicate was left behind either — the same transaction
    // (finding 1) rolls this back too.
    expect(
      projects
        .listProjects(organizationId, testDb.db, { includeArchived: true })
        .map((project) => project.name)
    ).toEqual(['Fall 2026'])
  })

  // "Also fix" (coordinator round 1 rework, from the notes): TEN-9's own
  // `discordServerId` was dropped from every field this action otherwise
  // copies faithfully — rolling a term forward in a two-binding
  // organization is the natural next thing an instructor does after that
  // slice, and a copy that silently forgot which server its source routed
  // in needed every course re-edited by hand before any of them could be
  // enabled again.
  it("copies a source course's own discordServerId, not merely every other field", async () => {
    testDb = createTestDatabase()
    const { organizationId, serverId } = seedOrganizationWithBoundServer(
      testDb.db
    )
    const project = projects.createProject(
      organizationId,
      { name: 'Fall 2026' },
      testDb.db
    )
    const source = courses.createCourse(
      organizationId,
      {
        projectId: project.id,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd-fa26',
        studentsRole: 'students-wd-fa26',
        discordServerId: serverId,
        categories: [],
      },
      testDb.db
    )
    if (!source.ok) throw new Error('setup failed: unexpected conflict')

    const result = await dispatch(
      duplicateProjectAction,
      { projectId: project.id, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    const copiedCourses = courses.listCourses(organizationId, testDb.db, {
      projectId: result.project.id,
    })
    expect(copiedCourses).toHaveLength(1)
    expect(copiedCourses[0]?.discordServerId).toBe(serverId)
  })

  // FILE-6/MDL-9 (also-fix, coordinator round 2 rework): a source course's
  // own websites were dropped the same way `discordServerId` was before
  // the fix above — rolling a term forward silently lost every course's
  // websites while `coursesCopied` still reported success, and nothing
  // told an instructor their duplicated course now answers ungrounded.
  it("copies a source course's own websites into its duplicate", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(
      testDb.db,
      'Fall 2026'
    )
    const source = courses.createCourse(
      organizationId,
      {
        projectId,
        title: 'Web Design',
        filePrefix: 'wd',
        enabled: true,
        adminsRole: 'admins-wd-fa26',
        studentsRole: 'students-wd-fa26',
        categories: [],
      },
      testDb.db
    )
    if (!source.ok) throw new Error('setup failed: unexpected conflict')
    courseWebSources.addWebSource(
      organizationId,
      { courseId: source.course.id, domain: 'example.edu' },
      testDb.db
    )
    courseWebSources.addWebSource(
      organizationId,
      { courseId: source.course.id, domain: 'docs.python.org' },
      testDb.db
    )

    const result = await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    const copiedCourses = courses.listCourses(organizationId, testDb.db, {
      projectId: result.project.id,
    })
    expect(copiedCourses).toHaveLength(1)
    const copiedWebSources = courseWebSources.listWebSourcesForCourse(
      organizationId,
      copiedCourses[0]!.id,
      testDb.db
    )
    expect(copiedWebSources.map((s) => s.domain).sort()).toEqual([
      'docs.python.org',
      'example.edu',
    ])

    // The source course's own websites are unchanged — this is a copy, not
    // a move.
    expect(
      courseWebSources
        .listWebSourcesForCourse(organizationId, source.course.id, testDb.db)
        .map((s) => s.domain)
        .sort()
    ).toEqual(['docs.python.org', 'example.edu'])
  })
})
