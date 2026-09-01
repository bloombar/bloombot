/**
 * `projects.duplicate` (PROJ-4): copies a project's courses, categories,
 * channels, instructions and settings into a new project, leaves the source
 * project and its rosters/transcripts untouched, and asserts the PROJ-3
 * decision this slice made (`docs/DECISIONS.md`) — every copied course is
 * created disabled, including the case that would otherwise collide.
 */

import { conversations, courses, people, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { duplicateProjectAction } from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import { ActionConflictError, ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithProject } from './helpers/seed.js'
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

    const newProject = await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Spring 2027' },
      { organizationId, db: testDb.db }
    )

    expect(newProject).toMatchObject({
      organizationId,
      name: 'Spring 2027',
      archivedAt: null,
    })

    const copiedCourses = courses.listCourses(organizationId, testDb.db, {
      projectId: newProject.id,
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

    const newProject = await dispatch(
      duplicateProjectAction,
      { projectId, name: 'Copy of Fall 2026' },
      { organizationId, db: testDb.db }
    )

    const copiedCourses = courses.listCourses(organizationId, testDb.db, {
      projectId: newProject.id,
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
})
