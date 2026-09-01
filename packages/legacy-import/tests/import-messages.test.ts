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
})
