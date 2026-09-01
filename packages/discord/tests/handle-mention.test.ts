/**
 * `handleMention` (SURF-1..6): the whole Discord surface, exercised against
 * a throwaway `tmp/` database and a fake model client — no discord.js, no
 * network. Each test below fails without the code named in its own
 * requirement id: see the report for how each was confirmed.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { courses, people, projects, type Database } from '@bloombot/db'

import {
  handleMention,
  type HandleMentionDependencies,
} from '../src/handle-mention.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { FakeModelClient } from './helpers/fake-model-client.js'
import { createFakeReplyPort } from './helpers/fake-reply-port.js'
import { BOT_ID, inboundMention } from './helpers/fixtures.js'
import { seedBoundServerWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Builds `handleMention`'s dependencies against a fresh model/reply/logger set for one test. */
function makeDeps(
  testDatabase: TestDatabase,
  overrides: Partial<HandleMentionDependencies> = {}
): {
  deps: HandleMentionDependencies
  model: FakeModelClient
  logger: ReturnType<typeof createFakeLogger>
  reply: ReturnType<typeof createFakeReplyPort>
} {
  const model = overrides.model ?? new FakeModelClient()
  const logger = createFakeLogger()
  const reply = createFakeReplyPort()
  return {
    model: model as FakeModelClient,
    logger,
    reply,
    deps: {
      db: testDatabase.db,
      model,
      logger,
      reply,
      day: '2026-01-01',
      ...overrides,
    },
  }
}

/**
 * A second, minimal enabled course in its own project — for tests (findings
 * 2 and 13) that need more than the one course `seedBoundServerWithCourse`
 * seeds. Every name is randomized so two calls in the same test never
 * collide with each other by accident, only on purpose when a test sets
 * `categoryName` to match an existing one.
 */
function createExtraCourse(
  db: Database,
  organizationId: string,
  categoryName: string
): { courseId: string; projectId: string } {
  const project = projects.createProject(
    organizationId,
    { name: `Extra Term ${randomUUID()}` },
    db
  )
  const result = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Extra Course',
      filePrefix: `ec-${randomUUID().slice(0, 8)}`,
      enabled: true,
      adminsRole: `admins-${randomUUID()}`,
      studentsRole: `students-${randomUUID()}`,
      maxRequestsPerDay: 10,
      promptId: null,
      instructions: 'Be helpful.',
      categories: [{ name: categoryName, channels: [] }],
    },
    db
  )
  if (!result.ok) {
    throw new Error(
      `createExtraCourse: failed to create course: ${result.conflict.message}`
    )
  }
  return { courseId: result.course.id, projectId: project.id }
}

describe('handleMention — SURF-2: only a direct mention is answered', () => {
  it("ignores the bot's own message, before any database or model call", async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model, reply } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({
        guildId,
        authorId: BOT_ID,
        text: `<@${BOT_ID}> talking to myself`,
      }),
      deps
    )

    expect(result).toEqual({ kind: 'ignored-self' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
  })

  it("ignores another bot's message, even though it mentions this bot", async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model, reply } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({
        guildId,
        authorId: 'some-other-bot',
        authorIsBot: true,
      }),
      deps
    )

    expect(result).toEqual({ kind: 'ignored-other-bot' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
  })

  it('ignores a message that does not mention the bot at all', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model, reply } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({ guildId, text: 'just chatting with another student' }),
      deps
    )

    expect(result).toEqual({ kind: 'ignored-not-a-mention' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
  })

  // Finding 3 of this rework: a Discord Reply carries no `<@id>` token in its
  // own text — Discord records who it is addressed to through the reply
  // relationship alone (`response_bot.py:164`'s own comment: "did not
  // directly mention *or reply to* this bot"). Without this, a student's
  // natural follow-up to a reply-in-place answer (SURF-5) would be silently
  // ignored.
  it('answers a message that replies to the bot even though its text carries no mention token', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({
        guildId,
        text: 'and what about the final?',
        repliesToBot: true,
      }),
      deps
    )

    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
  })

  it('answers a genuine mention, and the model receives the rewritten name while the transcript keeps what the student typed', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, model } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({ guildId, text: `<@${BOT_ID}> When is the midterm?` }),
      deps
    )

    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
    // BOT-6 — the model sees the readable name, never the raw snowflake token.
    expect(model.calls[0]?.question).toBe('@Bloombot When is the midterm?')
  })
})

describe('handleMention — SURF-3: a server not bound to an organization is ignored', () => {
  it('drops a message from an unbound guild, logging the cause, with no model call', async () => {
    testDb = createTestDatabase()
    const { deps, model, reply, logger } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({ guildId: 'never-bound-guild' }),
      deps
    )

    expect(result).toEqual({ kind: 'unbound-server' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })

  it('answers a message from a bound guild', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
  })
})

describe('handleMention — SURF-4: a person is recognized by their Discord account', () => {
  it('creates a person and identity on the first message, and reuses them on the second', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps: deps1 } = makeDeps(testDb)
    const { deps: deps2 } = makeDeps(testDb)

    await handleMention(
      inboundMention({ guildId, authorId: 'student-1' }),
      deps1
    )
    await handleMention(
      inboundMention({ guildId, authorId: 'student-1' }),
      deps2
    )

    const everyone = people.listPeople(organizationId, testDb.db)
    expect(everyone).toHaveLength(1)
  })

  it('keeps two different authors as two different people', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps: deps1 } = makeDeps(testDb)
    const { deps: deps2 } = makeDeps(testDb)

    await handleMention(
      inboundMention({ guildId, authorId: 'student-1' }),
      deps1
    )
    await handleMention(
      inboundMention({ guildId, authorId: 'student-2' }),
      deps2
    )

    const everyone = people.listPeople(organizationId, testDb.db)
    expect(everyone).toHaveLength(2)
  })
})

describe('handleMention — SURF-5: the reply is sent through the port, and a long answer is split', () => {
  it('sends the answer through `reply`, not any other channel', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const model = new FakeModelClient({ answerText: 'a short answer' })
    const { deps, reply } = makeDeps(testDb, { model })

    await handleMention(inboundMention({ guildId }), deps)

    expect(reply.sent).toEqual(['a short answer'])
  })

  it('splits an answer over the Discord limit into more than one message, in order, with nothing lost', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const longAnswer = 'word '.repeat(500) + 'end' // well over 2000 characters
    const model = new FakeModelClient({ answerText: longAnswer })
    const { deps, reply } = makeDeps(testDb, { model })

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
    expect(reply.sent.length).toBeGreaterThan(1)
    for (const part of reply.sent) {
      expect(part.length).toBeLessThanOrEqual(2000)
    }
    // Reassembling the parts loses nothing.
    expect(reply.sent.join('')).toBe(longAnswer)
  })
})

describe('handleMention — SURF-6: every outcome reaches the student or the log', () => {
  it('renders "answered"', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const { deps, reply } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
    expect(reply.sent).toHaveLength(1)
  })

  it('renders "answered-last-request", with the day\'s-last notice in the reply', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      maxRequestsPerDay: 1,
    })
    const { deps, reply } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered-last-request')
    expect(reply.sent[0]).toMatch(/reached the maximum number of responses/)
    // Finding 10 — the refusal text above is asserted identically by
    // `declined-over-limit`'s own test below; without this, a regression
    // that routed `answered-last-request` into the refusal branch (dropping
    // the student's actual answer) would keep both tests green.
    expect(reply.sent[0]).toMatch(/a fake answer/)
  })

  it('renders "declined-over-limit" as a refusal reaching the student, not silence', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      maxRequestsPerDay: 1,
    })
    const model = new FakeModelClient()
    const { deps: firstDeps } = makeDeps(testDb, { model })
    const { deps: secondDeps, reply } = makeDeps(testDb, { model })

    await handleMention(inboundMention({ guildId }), firstDeps) // reaches the limit
    const result = await handleMention(inboundMention({ guildId }), secondDeps) // over it

    expect(result).toEqual({ kind: 'declined-over-limit' })
    expect(model.calls).toHaveLength(1) // the second request never reached the model
    expect(reply.sent).toHaveLength(1)
    expect(reply.sent[0]).toMatch(/reached the maximum number of responses/)
  })

  it('renders "failed-with-apology" when the model call fails', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const model = new FakeModelClient()
    model.failNext()
    const { deps, reply } = makeDeps(testDb, { model })

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('failed-with-apology')
    expect(reply.sent[0]).toMatch(/can't respond intelligently/)
  })

  // Finding 9 of this rework: `answerQuestion`'s `failed-with-apology` also
  // carries `lastRequestOfDay` when the failed call was itself the day's
  // last — without rendering it, a provider outage on a student's last
  // request leaves them apologised to *and* silently locked out, with no
  // notice at all.
  it('renders "failed-with-apology" with the last-request notice too, when the failed call was also the day\'s last', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      maxRequestsPerDay: 1,
    })
    const model = new FakeModelClient()
    model.failNext()
    const { deps, reply } = makeDeps(testDb, { model })

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('failed-with-apology')
    expect(reply.sent[0]).toMatch(/can't respond intelligently/)
    expect(reply.sent[1]).toMatch(/reached the maximum number of responses/)
  })

  it('logs and stays silent for a course configured to answer nothing', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      instructions: null,
      promptId: null,
    })
    const { deps, reply, logger } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result).toEqual({ kind: 'not-configured' })
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })

  // `answerQuestion`'s own `course-disabled` result exists for a caller that
  // reaches it without going through routing (its own comment: "CORE-2's
  // routing already filters a disabled course out for the Discord
  // adapter"). `routeMessage` drops a disabled course before it can ever
  // match, so a disabled course reaches `handleMention` as `unrouted`, not
  // `course-disabled` — asserted here so that stays true rather than
  // assumed.
  it('routes around a disabled course entirely — it never reaches answerQuestion at all', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, { enabled: false })
    const { deps, model, reply, logger } = makeDeps(testDb)

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result).toEqual({ kind: 'unrouted' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })

  it('logs and stays silent for a message that matches no course', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Some Other Category',
    })
    const { deps, reply, logger } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({
        guildId,
        categoryName: 'Uncategorized',
        authorRoleNames: [],
      }),
      deps
    )

    expect(result).toEqual({ kind: 'unrouted' })
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })
})

describe('handleMention — PROJ-2/finding 2: an archived project stops its courses routing', () => {
  it('does not answer a message routed to a course whose project has been archived', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId, courseId } = seedBoundServerWithCourse(
      testDb.db
    )
    const course = courses.getCourse(organizationId, courseId, testDb.db)
    if (!course) throw new Error('setup failed: course not found')
    projects.archiveProject(organizationId, course.projectId, testDb.db)

    const { deps, model, reply, logger } = makeDeps(testDb)
    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result).toEqual({ kind: 'unrouted' })
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
    expect(logger.infoCalls.length).toBeGreaterThan(0)
  })

  it("a live course reusing an archived course's category name still routes, rather than becoming ambiguous", async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId, courseId } = seedBoundServerWithCourse(
      testDb.db,
      { categoryName: 'Shared Category' }
    )
    const archivedCourse = courses.getCourse(
      organizationId,
      courseId,
      testDb.db
    )
    if (!archivedCourse) throw new Error('setup failed: course not found')
    projects.archiveProject(organizationId, archivedCourse.projectId, testDb.db)

    // PROJ-3 permits this reuse once the first course's project is archived
    // (`repos/courses.ts`'s own `findCourseNameConflict`) — the case this
    // test exists to prove the *routing* half of, not just the save.
    createExtraCourse(testDb.db, organizationId, 'Shared Category')

    const { deps, model } = makeDeps(testDb)
    const result = await handleMention(
      inboundMention({ guildId, categoryName: 'Shared Category' }),
      deps
    )

    // Routed to the live course, not silenced by the archived one's
    // (identically-named) category.
    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
  })
})

describe('handleMention — CORE-2/finding 13: an ambiguous route is dropped, not answered', () => {
  it('drops a message that matches two enabled courses on the same category, logging at ERROR', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId, courseId } = seedBoundServerWithCourse(
      testDb.db,
      { categoryName: 'Shared Category' }
    )

    // PROJ-2/PROJ-3 together make two *live* courses sharing a category name
    // unreachable through the repo API itself — `createCourse` refuses the
    // collision outright, and `unarchiveProject` refuses to bring back a
    // course whose name was taken while it was archived
    // (`findProjectUnarchiveConflict`, `repos/courses.ts`). So this is
    // reached the only way it legitimately can be: the second course is
    // created in its own category first (respecting PROJ-3), then its
    // category is renamed directly on the schema, below the repo layer that
    // exists to prevent this exact state — proving `routeMessage`'s own
    // ambiguity branch (`routing.ts`'s own comment: "this should be
    // unreachable in ordinary operation") is still reported correctly if it
    // is ever reached.
    const { courseId: otherCourseId } = createExtraCourse(
      testDb.db,
      organizationId,
      'Temporary Category'
    )
    testDb.db.$client
      .prepare('UPDATE course_categories SET name = ? WHERE course_id = ?')
      .run('Shared Category', otherCourseId)

    const { deps, model, reply, logger } = makeDeps(testDb)
    const result = await handleMention(
      inboundMention({ guildId, categoryName: 'Shared Category' }),
      deps
    )

    expect(result.kind).toBe('routing-ambiguous')
    if (result.kind !== 'routing-ambiguous') {
      throw new Error('expected routing-ambiguous')
    }
    expect(result.signal).toBe('category')
    expect([...result.courseIds].sort()).toEqual(
      [courseId, otherCourseId].sort()
    )
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(0)
    expect(logger.errorCalls.length).toBeGreaterThan(0)
  })
})
