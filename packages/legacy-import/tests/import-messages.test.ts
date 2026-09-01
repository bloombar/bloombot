/**
 * MIG-3 (second half): a legacy message becomes a message with the right
 * direction, on the right conversation, with its original timestamp, and in
 * the right transcript order.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  conversations,
  courses,
  organizations,
  people,
  projects,
} from '@bloombot/db'

import { importMessages, loadRoutableCourses } from '../src/import-messages.js'
import { parseLegacyTimestamp } from '../src/read-legacy.js'
import type { LegacyMessage } from '../src/read-legacy.js'
import {
  createTestPlatformDatabase,
  type TestPlatformDatabase,
} from './helpers/platform-db.js'

let testDb: TestPlatformDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seed one organization, one project, one course with one category, and one person — the fixture every test in this file starts from. */
function seed(testDatabase: TestPlatformDatabase) {
  const orgId = randomUUID()
  organizations.createOrganization(
    orgId,
    { name: 'Org', isPersonal: false },
    testDatabase.db
  )
  const project = projects.createProject(
    orgId,
    { name: 'Term' },
    testDatabase.db
  )
  const courseResult = courses.createCourse(
    orgId,
    {
      projectId: project.id,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [{ name: 'Web Design - GLOBAL', channels: [] }],
    },
    testDatabase.db
  )
  if (!courseResult.ok) throw new Error('seed course save unexpectedly refused')
  const person = people.createPerson(orgId, {}, testDatabase.db)

  const routableCourses = loadRoutableCourses(
    orgId,
    [courseResult.course.id],
    testDatabase.db
  )
  const personByLegacyUserId = new Map([[1, person.id]])

  return {
    orgId,
    courseId: courseResult.course.id,
    personId: person.id,
    routableCourses,
    personByLegacyUserId,
  }
}

function legacyMessage(overrides: Partial<LegacyMessage> = {}): LegacyMessage {
  return {
    id: 1,
    createdAt: '2026-01-15 10:00:00.000000',
    content: 'Hello',
    category: 'Web Design - GLOBAL',
    channel: 'general',
    direction: 'from',
    userId: 1,
    ...overrides,
  }
}

describe('importMessages (MIG-3)', () => {
  it('records direction, the right conversation, and the original timestamp', () => {
    testDb = createTestPlatformDatabase()
    const { orgId, courseId, personId, routableCourses, personByLegacyUserId } =
      seed(testDb)

    const result = importMessages(
      orgId,
      [legacyMessage()],
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )

    expect(result).toMatchObject({ created: 1, matched: 0, unplaceable: [] })

    const conversation = conversations.getOrCreateConversation(
      orgId,
      { courseId, personId, surface: 'discord' },
      testDb.db
    )
    const transcript = conversations.getTranscript(
      orgId,
      conversation!.id,
      testDb.db
    )
    expect(transcript).toHaveLength(1)
    expect(transcript[0]?.direction).toBe('from_person')
    expect(transcript[0]?.content).toBe('Hello')
    expect(transcript[0]?.createdAt).toBe(
      parseLegacyTimestamp('2026-01-15 10:00:00.000000')
    )
  })

  it('maps "to" direction to to_person', () => {
    testDb = createTestPlatformDatabase()
    const { orgId, courseId, personId, routableCourses, personByLegacyUserId } =
      seed(testDb)

    importMessages(
      orgId,
      [legacyMessage({ direction: 'to', content: 'Hi there' })],
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )

    const conversation = conversations.getOrCreateConversation(
      orgId,
      { courseId, personId, surface: 'discord' },
      testDb.db
    )
    const transcript = conversations.getTranscript(
      orgId,
      conversation!.id,
      testDb.db
    )
    expect(transcript[0]?.direction).toBe('to_person')
  })

  it('preserves transcript order across several messages', () => {
    testDb = createTestPlatformDatabase()
    const { orgId, courseId, personId, routableCourses, personByLegacyUserId } =
      seed(testDb)

    const legacyMessages: LegacyMessage[] = [
      legacyMessage({
        id: 1,
        content: 'first',
        createdAt: '2026-01-15 10:00:00.000000',
      }),
      legacyMessage({
        id: 2,
        content: 'second',
        direction: 'to',
        createdAt: '2026-01-15 10:00:01.000000',
      }),
      legacyMessage({
        id: 3,
        content: 'third',
        createdAt: '2026-01-15 10:00:02.000000',
      }),
    ]

    importMessages(
      orgId,
      legacyMessages,
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )

    const conversation = conversations.getOrCreateConversation(
      orgId,
      { courseId, personId, surface: 'discord' },
      testDb.db
    )
    const transcript = conversations.getTranscript(
      orgId,
      conversation!.id,
      testDb.db
    )
    expect(transcript.map((m) => m.content)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('reports, rather than drops, a message whose category matches no course (MIG-4)', () => {
    testDb = createTestPlatformDatabase()
    const { orgId, routableCourses, personByLegacyUserId } = seed(testDb)

    const result = importMessages(
      orgId,
      [legacyMessage({ category: 'Nonexistent Category' })],
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )

    expect(result.created).toBe(0)
    expect(result.unplaceable).toHaveLength(1)
    expect(result.unplaceable[0]?.legacyMessageId).toBe(1)
    expect(result.unplaceable[0]?.reason).toMatch(/Nonexistent Category/)
  })

  // finding 5: `messages.id` is a single global primary key, not scoped per
  // conversation — a re-run that routes the same legacy message to a
  // *different* conversation (a course's `conversationScope` flipped to
  // `course_surface`, D-13, opens a new conversation for the same person)
  // must recognise the id as already-imported wherever it actually landed,
  // not just on the conversation this run happens to open. Before the fix,
  // the per-conversation check missed it and `appendMessage` threw
  // `SQLITE_CONSTRAINT_PRIMARYKEY` uncaught.
  it('recognises an already-imported message id after its course flips conversationScope', () => {
    testDb = createTestPlatformDatabase()
    const { orgId, courseId, routableCourses, personByLegacyUserId } =
      seed(testDb)

    // First run: lands on the course-scoped conversation (surface: null).
    const first = importMessages(
      orgId,
      [legacyMessage()],
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )
    expect(first).toMatchObject({ created: 1, matched: 0 })

    // Flip the course to `course_surface` — the next `getOrCreateConversation`
    // for this (course, person) opens a *new* conversation instead of
    // reusing the old one (`repos/conversations.ts`'s own documented
    // behaviour).
    const existingCourse = courses.getCourse(orgId, courseId, testDb.db)!
    courses.updateCourse(
      orgId,
      courseId,
      {
        projectId: existingCourse.projectId,
        title: existingCourse.title,
        filePrefix: existingCourse.filePrefix,
        enabled: existingCourse.enabled,
        adminsRole: existingCourse.adminsRole,
        studentsRole: existingCourse.studentsRole,
        conversationScope: 'course_surface',
        categories: existingCourse.categories,
      },
      testDb.db
    )
    // `importMessages` re-reads the course through `loadRoutableCourses`
    // (matching this file's own pattern), but the courses' ids and category
    // names are unchanged, so `routableCourses` is still valid for the
    // second run.

    // Re-running the same legacy message must not crash, and must report it
    // matched rather than duplicating it under a colliding id.
    const second = importMessages(
      orgId,
      [legacyMessage()],
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )
    expect(second).toMatchObject({ created: 0, matched: 1, unplaceable: [] })
  })

  // finding 8: a legacy row with an unparseable `created_at` is reported,
  // not thrown out of `importMessages` uncaught.
  it('reports, rather than throws, an unparseable created_at', () => {
    testDb = createTestPlatformDatabase()
    const { orgId, routableCourses, personByLegacyUserId } = seed(testDb)

    const result = importMessages(
      orgId,
      [legacyMessage({ createdAt: 'not-a-timestamp' })],
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )

    expect(result.created).toBe(0)
    expect(result.unplaceable).toHaveLength(1)
    expect(result.unplaceable[0]?.legacyMessageId).toBe(1)
    expect(result.unplaceable[0]?.reason).toMatch(/not-a-timestamp/)
  })
})

describe('buildCategoryIndex (finding 9, through importMessages)', () => {
  // The comment on `buildCategoryIndex` promises "the first course wins";
  // before the fix, `index.set` made the *last* course win instead, silently
  // disagreeing with `response_bot.py#find_course_by_category`'s own
  // first-match behaviour.
  it('routes a duplicate category to the first course that declares it, and reports the duplicate', () => {
    testDb = createTestPlatformDatabase()
    const orgId = randomUUID()
    organizations.createOrganization(
      orgId,
      { name: 'Org', isPersonal: false },
      testDb.db
    )
    const project = projects.createProject(orgId, { name: 'Term' }, testDb.db)
    const firstCourse = courses.createCourse(
      orgId,
      {
        projectId: project.id,
        title: 'First',
        filePrefix: 'first',
        enabled: true,
        adminsRole: 'admins-first',
        studentsRole: 'students-first',
        categories: [{ name: 'Shared - GLOBAL', channels: [] }],
      },
      testDb.db
    )

    // Two enabled courses in a non-archived project sharing a category name
    // is normally refused by PROJ-3 at save time — this reproduces the one
    // path that still reaches `importMessages` with a duplicate: a second
    // course saved into an *archived* project, whose PROJ-3 collision check
    // is skipped (`repos/courses.ts`'s `createCourse`).
    const archivedProject = projects.createProject(
      orgId,
      { name: 'Archived Term' },
      testDb.db
    )
    projects.archiveProject(orgId, archivedProject.id, testDb.db)
    const secondCourse = courses.createCourse(
      orgId,
      {
        projectId: archivedProject.id,
        title: 'Second',
        filePrefix: 'second',
        enabled: true,
        adminsRole: 'admins-second',
        studentsRole: 'students-second',
        categories: [{ name: 'Shared - GLOBAL', channels: [] }],
      },
      testDb.db
    )
    if (!firstCourse.ok || !secondCourse.ok) {
      throw new Error('seed course save unexpectedly refused')
    }
    const routableCourses = [
      { id: firstCourse.course.id, categoryNames: ['Shared - GLOBAL'] },
      { id: secondCourse.course.id, categoryNames: ['Shared - GLOBAL'] },
    ]
    const person = people.createPerson(orgId, {}, testDb.db)
    const personByLegacyUserId = new Map([[1, person.id]])

    const result = importMessages(
      orgId,
      [legacyMessage({ category: 'Shared - GLOBAL' })],
      personByLegacyUserId,
      routableCourses,
      testDb.db
    )

    expect(result.created).toBe(1)
    expect(result.duplicateCategories).toEqual([
      {
        categoryName: 'Shared - GLOBAL',
        courseId: firstCourse.course.id,
        ignoredCourseId: secondCourse.course.id,
      },
    ])

    const conversationsForFirst = conversations.listConversationsForCourse(
      orgId,
      firstCourse.course.id,
      testDb.db
    )
    expect(conversationsForFirst).toHaveLength(1)
    const conversationsForSecond = conversations.listConversationsForCourse(
      orgId,
      secondCourse.course.id,
      testDb.db
    )
    expect(conversationsForSecond).toHaveLength(0)
  })
})
