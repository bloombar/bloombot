import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

/**
 * Sets a course's `conversationScope` directly, bypassing `updateCourse`
 * (which, since finding 6 of the CONV-1 rework, is a real write path for
 * this column — see the `conversationScope (CONV-1)` tests below for that).
 * Kept here for the "scope changes after a conversation already exists"
 * test below, which only needs the column flipped in place, not a full
 * `NewCourse` payload re-saved through it.
 */
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

  // Finding 6 of the CONV-1 rework: `conversationScope` set at course
  // creation, through `createCourse`'s own `conversationScope` field — not
  // through the raw `setConversationScope` test helper — is what
  // `getOrCreateConversation` honours. Proves the write path finding 6
  // added is actually the thing this behaviour depends on, not just that
  // the column has the right value in the database.
  it('honours the `conversationScope` a course was created with', () => {
    testDb = createTestDatabase()
    const { orgA, personA } = seedTwoOrganizations(testDb)
    const project = projects.createProject(
      orgA,
      { name: 'Spring 2027' },
      testDb.db
    )
    const created = courses.createCourse(
      orgA,
      {
        projectId: project.id,
        title: 'Data Structures',
        filePrefix: 'ds',
        enabled: true,
        adminsRole: 'admins-ds',
        studentsRole: 'students-ds',
        conversationScope: 'course_surface',
        categories: [],
      },
      testDb.db
    )
    if (!created.ok) throw new Error('seed course creation failed')

    const fromDiscord = conversations.getOrCreateConversation(
      orgA,
      { courseId: created.course.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    const fromWeb = conversations.getOrCreateConversation(
      orgA,
      { courseId: created.course.id, personId: personA.id, surface: 'web' },
      testDb.db
    )

    expect(fromWeb?.id).not.toBe(fromDiscord?.id)
    expect(
      conversations.listConversationsForCourse(
        orgA,
        created.course.id,
        testDb.db
      )
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

  // Finding 3 of the CONV-1 rework: `createdAt` alone is not a determined
  // order — two messages appended within the same millisecond tie on it,
  // and SQL does not define an order among tied rows. Freezing the clock so
  // every append below genuinely shares one millisecond is what makes this
  // test fail without `messages.sequence`: before that column existed,
  // `getTranscript` ordered by `createdAt` alone, and with the clock frozen
  // every row in this test ties on it.
  it('orders a transcript by append order even when every message shares the same millisecond', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const conversation = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'))

      conversations.appendMessage(
        orgA,
        conversation.id,
        { direction: 'from_person', content: 'first' },
        testDb.db
      )
      conversations.appendMessage(
        orgA,
        conversation.id,
        { direction: 'to_person', content: 'second' },
        testDb.db
      )
      conversations.appendMessage(
        orgA,
        conversation.id,
        { direction: 'from_person', content: 'third' },
        testDb.db
      )
    } finally {
      vi.useRealTimers()
    }

    const transcript = conversations.getTranscript(
      orgA,
      conversation.id,
      testDb.db
    )

    // Every row ties on `createdAt` (the clock was frozen); only `sequence`
    // can be producing this order.
    expect(new Set(transcript.map((m) => m.createdAt)).size).toBe(1)
    expect(transcript.map((m) => m.content)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  // Finding 6 of the MIG-1 rework: a backdated append (`packages/legacy-import`,
  // MIG-3, is the one caller that supplies `createdAt` explicitly) must not
  // rewind a conversation's `lastMessageAt` — the later of the existing value
  // and the new message's `createdAt` wins, not the new message unconditionally.
  it('does not rewind lastMessageAt when a message is appended with a backdated createdAt', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const conversation = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    const recent = conversations.appendMessage(
      orgA,
      conversation.id,
      { direction: 'from_person', content: 'a live message' },
      testDb.db
    )
    if (!recent) throw new Error('seed message append failed')
    const afterLiveMessage = conversations.getConversation(
      orgA,
      conversation.id,
      testDb.db
    )
    expect(afterLiveMessage?.lastMessageAt).toBe(recent.createdAt)

    // A transcript import two years old lands after the live message above.
    const twoYearsAgo = recent.createdAt - 1000 * 60 * 60 * 24 * 365 * 2
    conversations.appendMessage(
      orgA,
      conversation.id,
      {
        direction: 'from_person',
        content: 'an imported, backdated message',
        createdAt: twoYearsAgo,
      },
      testDb.db
    )

    const afterImport = conversations.getConversation(
      orgA,
      conversation.id,
      testDb.db
    )
    // Still the live message's timestamp — not rewound to the import.
    expect(afterImport?.lastMessageAt).toBe(recent.createdAt)
  })

  // --- CONV-1: the upstream model thread id -------------------------------

  it('sets a conversation`s upstream thread id', () => {
    testDb = createTestDatabase()
    const { orgA, courseA, personA } = seedTwoOrganizations(testDb)

    const conversation = conversations.getOrCreateConversation(
      orgA,
      { courseId: courseA.id, personId: personA.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')
    expect(conversation.upstreamThreadId).toBeNull()

    const updated = conversations.setUpstreamThreadId(
      orgA,
      conversation.id,
      'thread_abc123',
      testDb.db
    )

    expect(updated?.upstreamThreadId).toBe('thread_abc123')
    expect(
      conversations.getConversation(orgA, conversation.id, testDb.db)
        ?.upstreamThreadId
    ).toBe('thread_abc123')
  })

  it('refuses to set an upstream thread id for a conversation belonging to another organization', () => {
    testDb = createTestDatabase()
    const { orgA, orgB, courseB, personB } = seedTwoOrganizations(testDb)

    const conversationB = conversations.getOrCreateConversation(
      orgB,
      { courseId: courseB.id, personId: personB.id, surface: 'discord' },
      testDb.db
    )
    if (!conversationB) throw new Error('seed conversation creation failed')

    const result = conversations.setUpstreamThreadId(
      orgA, // wrong organization
      conversationB.id,
      'thread_should_not_apply',
      testDb.db
    )

    expect(result).toBeUndefined()
    expect(
      conversations.getConversation(orgB, conversationB.id, testDb.db)
        ?.upstreamThreadId
    ).toBeNull()
  })

  // Finding 8 of the CONV-1 rework: the original version of this test
  // grepped `Object.keys(conversations)` for a function *name* matching
  // `/delete/i` — so a delete issued from inside a function not named
  // "delete" (a `purgeTranscript`, a `removeMessages`, or a plain
  // `db.delete(messages)` folded into some other function), or from another
  // module entirely, would pass it without ever being seen. This reads the
  // actual source of every repo file instead, and looks for the thing TEN-6
  // actually forbids: a `.delete(...)` call or a raw `DELETE FROM` against
  // `messages` or `conversations`, wherever it might appear.
  //
  // `organizations.ts#deleteOrganizationData` is the one named, explicit
  // exception — the same "an exception only if its reason is recorded in
  // the same test" ACT-5 already holds itself to. TEN-6's own text draws
  // the line this test enforces everywhere else: removing a bot preserves
  // data; ADMIN-5 is "the separate, deliberate operation that removes it"
  // TEN-6's own text names, reached only through the platform-administrator
  // console's own explicit-confirm-audited flow (`apps/api`'s admin
  // router), never through an ordinary write path.
  //
  // A rework finding: the original version of this exception excluded the
  // *whole file* — `organizations.ts` — rather than the one function, which
  // would silently admit a second, unaudited delete path added anywhere
  // else in that file later. Narrowed to `deleteOrganizationData`'s own
  // body: everything else in `organizations.ts` is still scanned exactly
  // like every other repo file.
  it('no repo source deletes a message or a conversation, anywhere in this package, except ADMIN-5’s own deliberate tenant deletion (TEN-6)', () => {
    const reposDir = fileURLToPath(new URL('../src/repos', import.meta.url))
    const files = readdirSync(reposDir).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    const deletePatterns = [
      /\.delete\(\s*messages\b/,
      /\.delete\(\s*conversations\b/,
      /delete\s+from\s+`?messages`?/i,
      /delete\s+from\s+`?conversations`?/i,
    ]

    // Every top-level `export function`/`export const` start, in
    // `organizations.ts` only — used to find where `deleteOrganizationData`'s
    // own body ends: the next export after it, or end of file.
    const topLevelExportStart = /^export (?:function|const) \w+/gm

    for (const file of files) {
      const source = readFileSync(`${reposDir}/${file}`, 'utf8')
      let scanned = source
      if (file === 'organizations.ts') {
        const starts = [...source.matchAll(topLevelExportStart)].map(
          (match) => match.index ?? 0
        )
        const deleteStart = source.indexOf(
          'export function deleteOrganizationData'
        )
        expect(deleteStart, 'deleteOrganizationData not found').toBeGreaterThan(
          -1
        )
        const deleteEnd =
          starts.find((index) => index > deleteStart) ?? source.length
        scanned = source.slice(0, deleteStart) + source.slice(deleteEnd)
      }
      for (const pattern of deletePatterns) {
        expect(scanned, `${file} matched ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})
