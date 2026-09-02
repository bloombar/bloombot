/**
 * `handleMention` (SURF-1..6): the whole Discord surface, exercised against
 * a throwaway `tmp/` database and a fake model client — no discord.js, no
 * network. Each test below fails without the code named in its own
 * requirement id: see the report for how each was confirmed.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  conversations,
  courses,
  enrolments,
  people,
  projects,
  usage,
  type Database,
} from '@bloombot/db'

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
      // LINK-2 — a plausible panel address; the exact value is only asserted
      // by this file's own LINK-1/LINK-2 tests below.
      connectUrl: 'https://app.bloombot.test',
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
    // `connectDefaultAuthor: false` — this test uses its own `authorId`s and
    // asserts an exact `listPeople` count; the seed's own pre-connected
    // default author (LINK-1) would otherwise add an unrelated extra person.
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
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
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
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

// D-31 rework — the identity-model gap: a roster imported before a student
// ever joined the server keeps them under a synthetic `handle:`-keyed
// identity (`roster-import.ts`'s own ROST-10 fallback). Before this fix,
// that student's first live message resolved by snowflake, found nothing,
// and `resolvePersonByIdentity` minted a *second* person — a second
// conversation, a second daily allowance, the roster's own fields stranded
// on the orphan. See `docs/DECISIONS.md`'s own entry on this rework.
describe('handleMention — D-31 rework: a roster-known person is reconciled with their first live message', () => {
  it("resolves a student's first message to the person a roster import already created under a handle:-keyed identity, rather than minting a second one", async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })

    // Simulates `roster-import.ts`'s own ROST-10 fallback directly, rather
    // than depending on `apps/worker` (out of this rework's own scope):
    // a roster row kept under a synthetic `handle:`-keyed identity, with
    // its roster fields already merged on.
    const rosterPerson = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'handle:ada-lovelace' },
      testDb.db
    )
    people.mergeRosterFields(
      organizationId,
      rosterPerson.id,
      { email: 'ada@example.edu', firstName: 'Ada' },
      testDb.db
    )

    const { deps } = makeDeps(testDb)
    await handleMention(
      inboundMention({
        guildId,
        authorId: 'snowflake-ada',
        // The same handle the roster row was keyed on — case-different, the
        // same tolerance `normalizeRosterHandle`/`normalizeHandle` give a
        // self-reported handle elsewhere in this platform.
        authorDisplayName: 'Ada-Lovelace',
      }),
      deps
    )

    const everyone = people.listPeople(organizationId, testDb.db)
    expect(everyone).toHaveLength(1)
    expect(everyone[0]?.id).toBe(rosterPerson.id)
    // The roster's own fields travel with the same person — not stranded on
    // a second, orphaned one.
    expect(everyone[0]?.email).toBe('ada@example.edu')
  })

  it("still creates a new person when no handle:-keyed identity matches the author's own display name", async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })

    people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'handle:someone-else' },
      testDb.db
    )

    const { deps } = makeDeps(testDb)
    await handleMention(
      inboundMention({
        guildId,
        authorId: 'snowflake-ada',
        authorDisplayName: 'Ada-Lovelace',
      }),
      deps
    )

    const everyone = people.listPeople(organizationId, testDb.db)
    // The pre-seeded `handle:someone-else` person, plus a genuinely new one
    // for Ada — no accidental match against an unrelated handle.
    expect(everyone).toHaveLength(2)
  })
})

describe('handleMention — LINK-1/LINK-2: an unconnected identity is invited to connect, not answered', () => {
  it('replies with the connect invitation, calls no model, and spends no allowance', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
    const { deps, model, reply } = makeDeps(testDb, {
      connectUrl: 'https://app.bloombot.test',
    })

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result).toEqual({ kind: 'invited-to-connect' })
    // LINK-1: "no model call is made and no allowance is spent."
    expect(model.calls).toHaveLength(0)
    expect(reply.sent).toHaveLength(1)
    expect(reply.sent[0]).toContain('https://app.bloombot.test')
  })

  // LINK-2: "the reply is the control panel's own address and nothing
  // more" — no token, no secret of any kind travels in a public channel.
  it('the invitation carries no token — just the address', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
    const { deps, reply } = makeDeps(testDb, {
      connectUrl: 'https://app.bloombot.test',
    })

    await handleMention(inboundMention({ guildId }), deps)

    expect(reply.sent).toHaveLength(1)
    const text = reply.sent[0] as string
    // The address, verbatim, and nothing that looks like a query string or
    // an appended secret (a `?`, `=` or `&` right after the URL, or the
    // words a token/state parameter would be named).
    expect(text).toContain('https://app.bloombot.test')
    expect(text).not.toMatch(/https:\/\/app\.bloombot\.test[?=&]/)
    expect(text).not.toMatch(/token|state|secret/i)
  })

  it('creates the person and identity even while declining to answer — PPL-3 still applies', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
    const { deps } = makeDeps(testDb)

    await handleMention(inboundMention({ guildId }), deps)

    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(1)
  })

  // LINK-6/7 — the connect flow (`apps/web`'s `pages/Connect.tsx`) needs to
  // know which organization's own person to look for before Discord's own
  // OAuth ever starts (`beginDiscordPersonLink`'s "bound at issue"); without
  // the organization id in the address, a signed-in caller's connect
  // attempt would have no way to find it. Not a secret (this file's own
  // `connectInvitationText` doc comment) — an ordinary path segment, not a
  // query string, so the "no token/state/secret" check just above still
  // holds for it.
  it('the invitation names the organization the message came from, so the connect screen knows which one to connect', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
    const { deps, reply } = makeDeps(testDb, {
      connectUrl: 'https://app.bloombot.test',
    })

    await handleMention(inboundMention({ guildId }), deps)

    expect(reply.sent).toHaveLength(1)
    expect(reply.sent[0]).toContain(
      `https://app.bloombot.test/connect/${organizationId}`
    )
  })

  // Rework finding 9 — `CONFIG.PUBLIC_APP_URL`'s own `z.url()` accepts a
  // trailing slash, and it used to be harmless (the bare URL travelled
  // verbatim). Appending a path made it not harmless: unstripped, this
  // produces `https://app.bloombot.test//connect/<org>` — a double slash
  // `apps/web`'s own route regex does not match, so a student following it
  // lands on the shell or sign-in with no connect screen and no error.
  it('strips a trailing slash from connectUrl before appending the connect path — no double slash', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
    const { deps, reply } = makeDeps(testDb, {
      connectUrl: 'https://app.bloombot.test/',
    })

    await handleMention(inboundMention({ guildId }), deps)

    expect(reply.sent).toHaveLength(1)
    expect(reply.sent[0]).toContain(
      `https://app.bloombot.test/connect/${organizationId}`
    )
    expect(reply.sent[0]).not.toContain('//connect/')
  })

  it('answers normally once the person is connected', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId } = seedBoundServerWithCourse(testDb.db, {
      connectDefaultAuthor: false,
    })
    // Connect the default author the same way a real proof would
    // (`@bloombot/auth`'s `person-link.ts`, once redeemed).
    const discordPerson = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'author-1' },
      testDb.db
    )
    const other = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: 'web-account-1' },
      testDb.db
    )
    people.mergePeople(organizationId, discordPerson.id, other.id, testDb.db)

    const { deps, model } = makeDeps(testDb)
    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
  })
})

describe('handleMention — LINK-5: one allowance and one conversation across surfaces, once connected', () => {
  it('a second surface (simulated by asking again after connecting) continues the same conversation and the same count', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId, courseId } = seedBoundServerWithCourse(
      testDb.db,
      { connectDefaultAuthor: false }
    )
    // A person already reached the course from a second surface (web),
    // before ever connecting Discord — its own conversation and usage exist
    // under a different person entirely, the way PPL-3 would leave them.
    const webPerson = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: 'web-account-1' },
      testDb.db
    )
    usage.incrementUsage(
      organizationId,
      courseId,
      webPerson.id,
      '2026-01-01',
      testDb.db
    )
    const webConversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId, personId: webPerson.id, surface: 'web' },
      testDb.db
    )
    if (!webConversation) throw new Error('setup failed')

    // Now the same person's Discord identity connects — LINK-4's merge.
    const discordPerson = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'author-1' },
      testDb.db
    )
    people.mergePeople(
      organizationId,
      webPerson.id,
      discordPerson.id,
      testDb.db
    )

    const { deps } = makeDeps(testDb, { day: '2026-01-01' })
    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result.kind).toBe('answered')
    // LINK-5: the count already reflects the web surface's own request —
    // this Discord message is the *second* of the day, not the first.
    expect(
      usage.getUsageCount(
        organizationId,
        courseId,
        webPerson.id,
        '2026-01-01',
        testDb.db
      )
    ).toBe(2)
    // This course's `conversationScope` defaults to `course` (CONV-1): one
    // conversation per person per course across every surface — Discord's
    // own message continues the *same* conversation the web surface
    // already opened, not a second one.
    if (result.kind !== 'answered') throw new Error('expected an answer')
    expect(result.conversationId).toBe(webConversation.id)
  })
})

describe('handleMention — D-34/LINK-5: a Discord role holder is admitted through the stored enrolment relation', () => {
  it('records an enrolment the first time a role holder is routed, and does not duplicate it on a second message', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId, courseId } = seedBoundServerWithCourse(
      testDb.db,
      { studentsRole: 'students-tc' }
    )
    expect(
      enrolments.listCoursesForPerson(
        organizationId,
        people.resolveIdentity(
          organizationId,
          { surface: 'discord', externalId: 'author-1' },
          testDb.db
        )?.id ?? '',
        testDb.db
      )
    ).toHaveLength(0)

    const { deps: deps1 } = makeDeps(testDb)
    await handleMention(
      inboundMention({ guildId, authorRoleNames: ['students-tc'] }),
      deps1
    )

    const person = people.resolveIdentity(
      organizationId,
      { surface: 'discord', externalId: 'author-1' },
      testDb.db
    )
    if (!person) throw new Error('setup failed')
    const afterFirst = enrolments.listCoursesForPerson(
      organizationId,
      person.id,
      testDb.db
    )
    expect(afterFirst.map((c) => c.id)).toEqual([courseId])

    const { deps: deps2 } = makeDeps(testDb)
    await handleMention(
      inboundMention({ guildId, authorRoleNames: ['students-tc'] }),
      deps2
    )

    // Still exactly one enrolment for this course — `enrolViaDiscordRole`'s
    // own idempotence (an existing active enrolment is left alone), not a
    // second row per message.
    const afterSecond = enrolments.listCoursesForPerson(
      organizationId,
      person.id,
      testDb.db
    )
    expect(afterSecond).toHaveLength(1)
  })

  // D-35 rework, finding 5 — ENRL-6's "ended ... stops the person asking
  // that course" now actually holds for a role holder, not merely for the
  // audit row: before this fix, `enrolViaDiscordRole`'s own `reviveEnded: true`
  // meant this student's very next `@bloombot` silently re-admitted them,
  // with no record the removal had ever happened.
  it('an instructor-ended enrolment stays ended, and the answer is refused, even though the student still holds the role', async () => {
    testDb = createTestDatabase()
    const { organizationId, guildId, courseId } = seedBoundServerWithCourse(
      testDb.db,
      { studentsRole: 'students-tc' }
    )
    const { deps: deps1, model: model1 } = makeDeps(testDb)
    await handleMention(
      inboundMention({ guildId, authorRoleNames: ['students-tc'] }),
      deps1
    )
    const person = people.resolveIdentity(
      organizationId,
      { surface: 'discord', externalId: 'author-1' },
      testDb.db
    )
    if (!person) throw new Error('setup failed')
    const [enrolment] = enrolments.listCoursesForPerson(
      organizationId,
      person.id,
      testDb.db
    )
    expect(enrolment?.id).toBe(courseId)
    const activeEnrolment = enrolments.getActiveEnrolment(
      organizationId,
      courseId,
      person.id,
      testDb.db
    )
    if (!activeEnrolment) throw new Error('setup failed')
    enrolments.endEnrolment(organizationId, activeEnrolment.id, testDb.db)

    const { deps: deps2, model: model2, reply } = makeDeps(testDb)
    const result = await handleMention(
      inboundMention({ guildId, authorRoleNames: ['students-tc'] }),
      deps2
    )

    expect(result).toEqual({ kind: 'enrolment-ended' })
    expect(model1.calls).toHaveLength(1) // the first message was answered
    expect(model2.calls).toHaveLength(0) // the second was not
    expect(reply.sent).toHaveLength(1)
    expect(reply.sent[0]).toMatch(/no longer enrolled/i)
    // Still ended, not silently revived — no record of a removal being
    // undone.
    expect(
      enrolments.getEnrolment(organizationId, activeEnrolment.id, testDb.db)
        ?.endedAt
    ).not.toBeNull()
    expect(
      enrolments.listCoursesForPerson(organizationId, person.id, testDb.db)
    ).toHaveLength(0)
  })

  // A person who holds only the *admin* role (never `studentsRole`, ENRL-5's
  // own "a Discord role confers none of them") is untouched by this gate —
  // `enrolViaDiscordRole` never admits them in the first place, so there is
  // no enrolment for this check to find missing.
  it('does not gate an admin-role message that never held a student enrolment at all', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      adminsRole: 'admins-tc',
    })
    const { deps, model } = makeDeps(testDb)

    const result = await handleMention(
      inboundMention({ guildId, authorRoleNames: ['admins-tc'] }),
      deps
    )

    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
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

  // Rework finding 1 — a busy course (JOB-4's admission gate never freed a
  // slot within the wait ceiling) is neither of the two cases SURF-6
  // reserves for log-only: not a course configured to answer nothing, and
  // not a message matching no course. The student must be told they are
  // waiting rather than left with silence indistinguishable from the bot
  // being offline (JOB-4's own text). Before this fix, `declined-busy`
  // logged and returned without ever calling `reply`, so `reply.sent` stayed
  // empty here.
  it('renders "declined-busy" as a refusal reaching the student, not silence', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db)
    const neverGrants = { acquire: async () => ({ granted: false as const }) }
    const { deps, model, reply } = makeDeps(testDb, { admission: neverGrants })

    const result = await handleMention(inboundMention({ guildId }), deps)

    expect(result).toEqual({ kind: 'declined-busy' })
    expect(model.calls).toHaveLength(0) // never reached the model
    expect(reply.sent).toHaveLength(1)
    expect(reply.sent[0]).toMatch(/busy/i)
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
