import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'

import {
  conversations,
  courses,
  organizations,
  people,
  projects,
  schema,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds two organizations, each with one project, one course and one person, synthetic data only (QA-3). */
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
    { name: 'Fall 2026' },
    testDatabase.db
  )

  const courseA = courses.createCourse(
    orgA,
    {
      projectId: projectA.id,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    testDatabase.db
  )
  const courseB = courses.createCourse(
    orgB,
    {
      projectId: projectB.id,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseA.ok || !courseB.ok) throw new Error('seed course creation failed')

  const personA = people.createPerson(
    orgA,
    { displayName: 'A' },
    testDatabase.db
  )
  const personB = people.createPerson(
    orgB,
    { displayName: 'B' },
    testDatabase.db
  )

  return {
    orgA,
    orgB,
    courseA: courseA.course,
    courseB: courseB.course,
    personA,
    personB,
  }
}

/** Sets a course's `conversationScope` directly — no repo function exposes this write (out of this slice's scope). */
function setConversationScope(
  courseId: string,
  scope: schema.ConversationScope,
  db: TestDatabase['db']
) {
  db.update(schema.courses)
    .set({ conversationScope: scope })
    .where(eq(schema.courses.id, courseId))
    .run()
}

describe('conversations repo', () => {
  // --- Tenant scoping (TEN-2/TEN-5) ---------------------------------------

  it('refuses to get-or-create a conversation for a course belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, courseB, personA } = seedTwoOrganizations(testDb)

    const result = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseB.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )

    expect(result).toBeUndefined()
  })

  it('refuses to get-or-create a conversation for a person belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personB } = seedTwoOrganizations(testDb)

    const result = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personB.id, surface: 'discord' },
      testDb.db
    )

    expect(result).toBeUndefined()
  })

  it('refuses to append a message to a conversation belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseB, personB } = seedTwoOrganizations(testDb)

    const conversationB = conversations.getOrCreateConversation(
      orgB,
      { courseId: courseB.id, personId: personB.id, surface: 'discord' },
      testDb.db
    )
    if (!conversationB) throw new Error('seed conversation creation failed')

    const result = conversations.appendMessage(
      orgA, // wrong organization
      conversationB.id,
      { direction: 'from_person', content: 'hello' },
      testDb.db
    )

    expect(result).toBeUndefined()
    // Untouched.
    expect(
      conversations.getTranscript(orgB, conversationB.id, testDb.db)
    ).toHaveLength(0)
  })

  it('a transcript reads only its own organization`s conversation', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseA, courseB, personA, personB } =
      seedTwoOrganizations(testDb)

    const conversationA = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    const conversationB = conversations.getOrCreateConversation(
      orgB,
      { courseId: courseB.id, personId: personB.id, surface: 'discord' },
      testDb.db
    )
    if (!conversationA || !conversationB)
      throw new Error('seed conversation creation failed')

    conversations.appendMessage(
      orgA,
      conversationA.id,
      { direction: 'from_person', content: 'hi' },
      testDb.db
    )

    // Reading Org A's conversation id, scoped to Org B, is refused as absence.
    expect(
      conversations.getTranscript(orgB, conversationA.id, testDb.db)
    ).toHaveLength(0)
    expect(
      conversations.getTranscript(orgA, conversationA.id, testDb.db)
    ).toHaveLength(1)
  })

  // --- CONV-1: the scope rule is structural -------------------------------

  it('scope `course` (the default): two surfaces from the same person land in one conversation', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const fromDiscord = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    const fromWeb = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'web' },
      testDb.db
    )

    expect(fromWeb?.id).toBe(fromDiscord?.id)
    expect(
      conversations.listConversationsForCourse(orgA, courseA.id, testDb.db)
    ).toHaveLength(1)
  })

  it('scope `course_surface`: two surfaces from the same person land in two conversations', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)
    setConversationScope(courseA.id, 'course_surface', testDb.db)

    const fromDiscord = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    const fromWeb = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'web' },
      testDb.db
    )

    expect(fromWeb?.id).not.toBe(fromDiscord?.id)
    expect(
      conversations.listConversationsForCourse(orgA, courseA.id, testDb.db)
    ).toHaveLength(2)
  })

  // Changing a course's scope after conversations already exist does not
  // merge or split them — this package has no such migration path.
  // Documented in `docs/DECISIONS.md`: the effect actually observed is that
  // a scope change makes the *next* `getOrCreateConversation` call look for
  // a row keyed differently than any existing one, so it creates a fresh
  // conversation alongside the old one rather than reusing or rewriting it.
  it('changing a course`s scope after a conversation exists does not merge or split it — a new one is created instead', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const beforeChange = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    expect(beforeChange?.surface).toBeNull()

    setConversationScope(courseA.id, 'course_surface', testDb.db)

    const afterChange = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )

    // A new, distinct row — the old `surface: null` conversation is neither
    // reused nor deleted.
    expect(afterChange?.id).not.toBe(beforeChange?.id)
    expect(afterChange?.surface).toBe('discord')
    const all = conversations.listConversationsForCourse(
      orgA,
      courseA.id,
      testDb.db
    )
    expect(all).toHaveLength(2)
    expect(all.some((c) => c.id === beforeChange?.id)).toBe(true)
  })

  // --- CONV-2: the transcript records both directions --------------------

  it('reads a transcript back in order, with both directions present', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const conversation = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    conversations.appendMessage(
      orgA,
      conversation.id,
      { direction: 'from_person', content: 'What is a closure?' },
      testDb.db
    )
    conversations.appendMessage(
      orgA,
      conversation.id,
      {
        direction: 'to_person',
        content: 'A function bundled with its lexical scope.',
      },
      testDb.db
    )
    conversations.appendMessage(
      orgA,
      conversation.id,
      { direction: 'from_person', content: 'Thanks!' },
      testDb.db
    )

    const transcript = conversations.getTranscript(
      orgA,
      conversation.id,
      testDb.db
    )

    expect(transcript.map((m) => m.direction)).toEqual([
      'from_person',
      'to_person',
      'from_person',
    ])
    expect(transcript.map((m) => m.content)).toEqual([
      'What is a closure?',
      'A function bundled with its lexical scope.',
      'Thanks!',
    ])
  })

  it('has no delete path for a message anywhere in this repo (TEN-6)', () => {
    const exportedNames = Object.keys(conversations)
    expect(exportedNames.some((name) => /delete/i.test(name))).toBe(false)
  })
})
