/**
 * `answerQuestion` (CORE-1, CORE-3, CORE-4, CORE-5, CORE-6) — the whole
 * pipeline exercised against a throwaway `tmp/` database and
 * `FakeModelClient`, never a real network call or `data/`.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { conversations, courses, usage, type Database } from '@bloombot/db'

import { answerQuestion } from '../src/answer.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { FakeModelClient } from './helpers/fake-model-client.js'
import { seedCourseAndPerson } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/**
 * Makes `db.transaction` throw on its `failOnCallNumber`-th invocation
 * (1-indexed) instead of running the callback, and pass every other call
 * through unchanged — CORE-6's "inject a failing db write". `appendMessage`
 * (`repos/conversations.ts`) is the only function `answerQuestion` calls
 * that opens a transaction, so its *first* call is always the inbound
 * message and its *second* is always the reply, in that order.
 */
function makeTransactionFailOnce(db: Database, failOnCallNumber: number): void {
  const original = db.transaction.bind(db)
  let callCount = 0
  // `db.transaction` is a real drizzle method with overloaded call
  // signatures a test double cannot restate faithfully — cast rather than
  // fight the overloads, the same allowance the root eslint config grants
  // `packages/*/tests/**/*.ts` for `any`.

  ;(db as any).transaction = (...args: any[]) => {
    callCount += 1
    if (callCount === failOnCallNumber) {
      throw new Error('simulated transaction failure')
    }

    return (original as any)(...args)
  }
}

describe('answerQuestion (CORE-1): one pipeline for every surface', () => {
  it('answers identically for two different surfaces, and records the surface on each message', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      answerText: 'the same pipeline answered',
    })
    const logger = createFakeLogger()

    const discordResult = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'Question from Discord',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )
    const webResult = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'web',
        text: 'Question from the web',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(discordResult.kind).toBe('answered')
    expect(webResult.kind).toBe('answered')
    if (discordResult.kind !== 'answered' || webResult.kind !== 'answered') {
      throw new Error('expected both calls to answer')
    }
    expect(discordResult.text).toBe('the same pipeline answered')
    expect(webResult.text).toBe('the same pipeline answered')

    // The default `conversationScope` ('course') merges every surface into
    // one conversation (CONV-1) — both calls land on the same transcript.
    expect(webResult.conversationId).toBe(discordResult.conversationId)
    const transcript = conversations.getTranscript(
      organizationId,
      discordResult.conversationId,
      testDb.db
    )
    expect(
      transcript.map((message) => [message.direction, message.surface])
    ).toEqual([
      ['from_person', 'discord'],
      ['to_person', 'discord'],
      ['from_person', 'web'],
      ['to_person', 'web'],
    ])
  })
})

describe('answerQuestion (CORE-3): the daily allowance is checked before the model is asked', () => {
  it('answers under the limit, adds the notice on the request that reaches it, declines the next without calling the model, and a new day starts the count over', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { maxRequestsPerDay: 2 }
    )
    const model = new FakeModelClient({ answerText: 'an answer' })
    const logger = createFakeLogger()
    const day = '2026-01-01'

    const first = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q1',
        day,
      },
      { db: testDb.db, model, logger }
    )
    expect(first.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)

    // Finding 5 of the CORE-1 rework: D-3's `promptId`/`instructions` pair
    // reaches the port straight off the course row, unresolved, and the
    // conversation's first turn has no upstream thread id yet.
    expect(model.calls[0]?.promptId).toBe(null)
    expect(model.calls[0]?.instructions).toBe('Be helpful.')
    expect(model.calls[0]?.upstreamThreadId).toBe(null)

    // CONV-1: "a conversation records the upstream model thread it
    // corresponds to, so the model's own context can be resumed" — the
    // fake's own returned thread id (`fake-thread-1`, `FakeModelClient`'s
    // default) is what `answerQuestion` must have persisted.
    if (first.kind !== 'answered') throw new Error('expected an answer')
    expect(
      conversations.getConversation(
        organizationId,
        first.conversationId,
        testDb.db
      )?.upstreamThreadId
    ).toBe('fake-thread-1')

    const second = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q2',
        day,
      },
      { db: testDb.db, model, logger }
    )
    expect(second.kind).toBe('answered-last-request')
    expect(model.calls).toHaveLength(2)
    if (second.kind === 'answered-last-request') {
      expect(second.text).toContain('reached the maximum number of responses')
      expect(second.text).toContain('an answer')
    }

    // The round trip: the second turn is handed back the first turn's own
    // upstream thread id, not `null` — the model's context can be resumed.
    expect(model.calls[1]?.upstreamThreadId).toBe('fake-thread-1')

    // The over-limit request costs nothing (CORE-3): the fake records no
    // third call at all.
    const third = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q3',
        day,
      },
      { db: testDb.db, model, logger }
    )
    expect(third).toEqual({ kind: 'declined-over-limit' })
    expect(model.calls).toHaveLength(2)
    expect(
      usage.getUsageCount(organizationId, courseId, personId, day, testDb.db)
    ).toBe(2)

    // A different day starts the count over.
    const nextDay = '2026-01-02'
    const fourth = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q4',
        day: nextDay,
      },
      { db: testDb.db, model, logger }
    )
    expect(fourth.kind).toBe('answered')
    expect(model.calls).toHaveLength(3)
  })
})

describe('answerQuestion (finding 2 of the CORE-1 rework): a null `maxRequestsPerDay` is capped at BOT-5s default, not unlimited', () => {
  it('declines the eleventh request for a course whose limit was never configured', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { maxRequestsPerDay: null }
    )
    const model = new FakeModelClient({ answerText: 'an answer' })
    const logger = createFakeLogger()
    const day = '2026-01-01'

    for (let i = 0; i < 10; i++) {
      const result = await answerQuestion(
        {
          organizationId,
          courseId,
          personId,
          surface: 'discord',
          text: `q${i}`,
          day,
        },
        { db: testDb.db, model, logger }
      )
      expect(result.kind).not.toBe('declined-over-limit')
    }
    expect(model.calls).toHaveLength(10)

    const eleventh = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q11',
        day,
      },
      { db: testDb.db, model, logger }
    )
    expect(eleventh).toEqual({ kind: 'declined-over-limit' })
    expect(model.calls).toHaveLength(10)
  })
})

describe('answerQuestion (finding 8 of the CORE-1 rework): the allowance is reserved atomically, before the model is asked', () => {
  it('grants only one of two requests racing for the last slot, never both', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { maxRequestsPerDay: 1 }
    )
    const model = new FakeModelClient({ answerText: 'an answer' })
    const logger = createFakeLogger()
    const day = '2026-01-01'

    // Neither call is awaited before the other starts — both `answerQuestion`
    // invocations below run synchronously up to their own first `await`
    // (the model call) before either resumes, the same interleaving two
    // real concurrent mentions from one student produce around the network
    // call this fake model client stands in for. If the allowance were still
    // checked and incremented as two separate steps straddling that `await`
    // (the shape this fix replaces), both would read the same "0 used" count
    // before either wrote, and both would be granted — this is the
    // regression finding 8 exists to close.
    const [first, second] = await Promise.all([
      answerQuestion(
        {
          organizationId,
          courseId,
          personId,
          surface: 'discord',
          text: 'q1',
          day,
        },
        { db: testDb.db, model, logger }
      ),
      answerQuestion(
        {
          organizationId,
          courseId,
          personId,
          surface: 'discord',
          text: 'q2',
          day,
        },
        { db: testDb.db, model, logger }
      ),
    ])

    // Deterministic, not flaky: `reserveUsageSlot` runs synchronously before
    // either call's first `await`, so whichever call the JS engine starts
    // first (the first element of the array above) always wins the slot.
    expect(first.kind).toBe('answered-last-request')
    expect(second).toEqual({ kind: 'declined-over-limit' })
    expect(model.calls).toHaveLength(1)
    expect(
      usage.getUsageCount(organizationId, courseId, personId, day, testDb.db)
    ).toBe(1)
  })
})

describe('answerQuestion (CORE-5): a model failure degrades to a logged apology', () => {
  it('returns an apology, still records the inbound message, and logs the failure', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient()
    model.failNext(new Error('upstream is down'))
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'Will this work?',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('failed-with-apology')
    if (result.kind === 'failed-with-apology') {
      expect(result.text).toMatch(/can't respond intelligently right now/)
      expect(result.text).toContain('Test Course admins')

      const transcript = conversations.getTranscript(
        organizationId,
        result.conversationId,
        testDb.db
      )
      expect(transcript).toHaveLength(2)
      expect(transcript[0]?.direction).toBe('from_person')
      expect(transcript[0]?.content).toBe('Will this work?')
      expect(transcript[1]?.direction).toBe('to_person')
      expect(transcript[1]?.content).toBe(result.text)
    }

    expect(logger.errorCalls.length).toBeGreaterThan(0)
  })

  // Finding 7 of the CORE-1 rework: a model failure on the request that
  // also reached the allowance must not lose the "today is over" fact —
  // during a provider outage, a student who burns every request otherwise
  // gets ten apologies and no notice at all before going silent.
  it('carries `lastRequestOfDay` on a failed request that also reached the allowance, without changing the apology text', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { maxRequestsPerDay: 1 }
    )
    const model = new FakeModelClient()
    model.failNext(new Error('upstream is down'))
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('failed-with-apology')
    if (result.kind === 'failed-with-apology') {
      // The apology's own wording is unchanged — still byte-identical to
      // `response_bot.py`'s, never combined with the last-request notice's
      // text — the fact travels as structured data instead.
      expect(result.text).toBe(
        "Sorry, I can't respond intelligently right now. Please see Test Course admins for help."
      )
      expect(result.lastRequestOfDay).toBe(true)
    }
    // The allowance was still spent — reserved before the model call
    // (finding 8), regardless of whether the model call itself succeeded.
    expect(
      usage.getUsageCount(
        organizationId,
        courseId,
        personId,
        '2026-01-01',
        testDb.db
      )
    ).toBe(1)
  })

  it('does not carry `lastRequestOfDay` on a failed request that had slots to spare', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { maxRequestsPerDay: 5 }
    )
    const model = new FakeModelClient()
    model.failNext(new Error('upstream is down'))
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('failed-with-apology')
    if (result.kind === 'failed-with-apology') {
      expect(result.lastRequestOfDay).toBe(false)
    }
  })
})

describe('answerQuestion (CORE-6): both directions are recorded, and a failed write never blocks the reply', () => {
  it('records the question then the answer, in order, on one conversation', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({ answerText: 'the recorded answer' })
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'the recorded question',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )
    expect(result.kind).toBe('answered')

    const conversationId =
      result.kind === 'answered' ? result.conversationId : ''
    const transcript = conversations.getTranscript(
      organizationId,
      conversationId,
      testDb.db
    )
    expect(
      transcript.map((message) => [message.direction, message.content])
    ).toEqual([
      ['from_person', 'the recorded question'],
      ['to_person', 'the recorded answer'],
    ])
  })

  // Finding 6 of the CORE-1 rework: DATA-4's Discord context belongs on
  // *both* directions of the exchange, not just the inbound question — a
  // reply recorded with no `channelRef`/`categoryRef` loses the context an
  // imported historical reply (MIG-3) still carries.
  it('records the Discord channel and category context on both the question and the answer', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({ answerText: 'the recorded answer' })
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'the recorded question',
        day: '2026-01-01',
        channelRef: 'general',
        categoryRef: 'Web Design',
      },
      { db: testDb.db, model, logger }
    )
    expect(result.kind).toBe('answered')

    const conversationId =
      result.kind === 'answered' ? result.conversationId : ''
    const transcript = conversations.getTranscript(
      organizationId,
      conversationId,
      testDb.db
    )
    expect(
      transcript.map((message) => [
        message.direction,
        message.channelRef,
        message.categoryRef,
      ])
    ).toEqual([
      ['from_person', 'general', 'Web Design'],
      ['to_person', 'general', 'Web Design'],
    ])
  })

  it('still returns the answer when persisting the upstream thread id fails', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      answerText: 'an answer despite the failed thread id write',
    })
    const logger = createFakeLogger()

    // The inbound message's transaction (the first `db.transaction` call)
    // must succeed; `setUpstreamThreadId` is a plain `update`, not a
    // transaction, so it is untouched by `makeTransactionFailOnce` — it is
    // made to fail directly instead, the same way the transaction-based
    // writes above are.
    const originalUpdate = testDb.db.update.bind(testDb.db)
    let updateCallCount = 0
    // `db.update` has overloaded signatures a test double cannot restate
    // faithfully — cast rather than fight the overloads, the same allowance
    // this file's own `makeTransactionFailOnce` takes above.
    ;(testDb.db as any).update = (...args: any[]) => {
      updateCallCount += 1
      // The first `update` call after the model resolves is
      // `setUpstreamThreadId`'s.
      if (updateCallCount === 1) {
        throw new Error('simulated update failure')
      }
      return (originalUpdate as any)(...args)
    }

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'a question whose thread id write will fail',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('answered')
    if (result.kind === 'answered') {
      expect(result.text).toBe('an answer despite the failed thread id write')
    }
    expect(logger.errorCalls.length).toBeGreaterThan(0)
  })

  it('still returns the answer when the reply write fails', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      answerText: 'an answer despite the failed write',
    })
    const logger = createFakeLogger()

    // The inbound message's own transaction (the first) must succeed, so
    // the failure is isolated to the reply's — the second.
    makeTransactionFailOnce(testDb.db, 2)

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'a question whose reply write will fail',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('answered')
    if (result.kind === 'answered') {
      expect(result.text).toBe('an answer despite the failed write')

      // Only the inbound message made it onto the transcript — the reply's
      // write failed and was logged, not silently retried or swallowed.
      const transcript = conversations.getTranscript(
        organizationId,
        result.conversationId,
        testDb.db
      )
      expect(transcript).toHaveLength(1)
      expect(transcript[0]?.direction).toBe('from_person')
    }
    expect(logger.errorCalls.length).toBeGreaterThan(0)
  })

  it('still asks the model and returns the answer when the inbound write fails', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      answerText: 'an answer despite the failed inbound write',
    })
    const logger = createFakeLogger()

    // The inbound message's own transaction is the first `db.transaction`
    // call `answerQuestion` makes — failing it must not stop the model from
    // being asked or the reply from being recorded.
    makeTransactionFailOnce(testDb.db, 1)

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'a question whose own write will fail',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
    if (result.kind === 'answered') {
      expect(result.text).toBe('an answer despite the failed inbound write')

      // Only the reply made it onto the transcript — the inbound write
      // failed and was logged, not silently retried or swallowed.
      const transcript = conversations.getTranscript(
        organizationId,
        result.conversationId,
        testDb.db
      )
      expect(transcript).toHaveLength(1)
      expect(transcript[0]?.direction).toBe('to_person')
    }
    expect(logger.errorCalls.length).toBeGreaterThan(0)
  })
})

describe('answerQuestion: a courseId or personId that does not resolve is caller misuse, not an ordinary outcome', () => {
  it('throws when courseId does not exist in the organization', async () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedCourseAndPerson(testDb.db)
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await expect(
      answerQuestion(
        {
          organizationId,
          courseId: 'no-such-course',
          personId,
          surface: 'discord',
          text: 'q',
          day: '2026-01-01',
        },
        { db: testDb.db, model, logger }
      )
    ).rejects.toThrow(/course/)
    expect(model.calls).toHaveLength(0)
  })

  it('throws when personId does not exist in the organization', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId } = seedCourseAndPerson(testDb.db)
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    // Finding 8 of the CORE-1 rework moved the allowance reservation ahead
    // of `getOrCreateConversation` (so an over-limit request still costs
    // nothing) — an invalid `personId` is now caught there instead, by
    // `reserveUsageSlot`'s own tenant-scoping check, not by conversation
    // creation. The thrown message changes; the "still throws, never calls
    // the model" behaviour does not.
    await expect(
      answerQuestion(
        {
          organizationId,
          courseId,
          personId: 'no-such-person',
          surface: 'discord',
          text: 'q',
          day: '2026-01-01',
        },
        { db: testDb.db, model, logger }
      )
    ).rejects.toThrow(/usage slot/)
    expect(model.calls).toHaveLength(0)
  })
})

describe('answerQuestion (finding 1 of the CORE-1 rework): a disabled course is never answered, even reached directly (not through routing)', () => {
  it('declines a disabled course without recording anything or calling the model', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    courses.disableCourse(organizationId, courseId, testDb.db)
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result).toEqual({ kind: 'course-disabled' })
    expect(model.calls).toHaveLength(0)
    expect(
      usage.getUsageCount(
        organizationId,
        courseId,
        personId,
        '2026-01-01',
        testDb.db
      )
    ).toBe(0)
  })
})

describe('answerQuestion (finding 3 of the CORE-1 rework): a course with neither a promptId nor instructions is never sent to the model', () => {
  it('declines without calling the model or counting the request, and logs the course id', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { promptId: null, instructions: null }
    )
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result).toEqual({ kind: 'not-configured' })
    expect(model.calls).toHaveLength(0)
    expect(
      usage.getUsageCount(
        organizationId,
        courseId,
        personId,
        '2026-01-01',
        testDb.db
      )
    ).toBe(0)
    expect(
      logger.infoCalls.some(
        (call) => (call[0] as Record<string, unknown>)?.courseId === courseId
      )
    ).toBe(true)
  })

  it('still answers when only `promptId` is set, with no `instructions`', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { promptId: 'prompt-only', instructions: null }
    )
    const model = new FakeModelClient({ answerText: 'an answer' })
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('answered')
    expect(model.calls).toHaveLength(1)
  })
})

describe('answerQuestion (finding 9 of the CORE-1 rework): BOT-10s one INFO line on the success path', () => {
  it('logs the conversation id, resolved prompt id, answer, and the running count against the limit', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { maxRequestsPerDay: 5, promptId: 'prompt-123', instructions: null }
    )
    const model = new FakeModelClient({ answerText: 'the logged answer' })
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )
    expect(result.kind).toBe('answered')
    const conversationId =
      result.kind === 'answered' ? result.conversationId : ''

    const successLog = logger.infoCalls.find(
      (call) =>
        (call[0] as Record<string, unknown> | undefined)?.answer ===
        'the logged answer'
    )
    expect(successLog).toBeDefined()
    expect(successLog?.[0]).toMatchObject({
      conversationId,
      promptId: 'prompt-123',
      answer: 'the logged answer',
      count: 1,
      limit: 5,
    })
  })
})

describe('answerQuestion (finding 10 of the CORE-1 rework): `text` is recorded, `modelText` is what the model is asked', () => {
  it('sends `modelText` to the model but records the unrewritten `text` on the transcript', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({ answerText: 'an answer' })
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: '<@123456789> what is the deadline?',
        modelText: '@Bloombot what is the deadline?',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('answered')
    expect(model.calls[0]?.question).toBe('@Bloombot what is the deadline?')

    const conversationId =
      result.kind === 'answered' ? result.conversationId : ''
    const transcript = conversations.getTranscript(
      organizationId,
      conversationId,
      testDb.db
    )
    // The raw, un-rewritten mention is what lands on the instructor-visible
    // transcript — not the text sent to the model.
    expect(transcript[0]?.content).toBe('<@123456789> what is the deadline?')
  })

  it('defaults `modelText` to `text` when the caller has nothing to rewrite', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({ answerText: 'an answer' })
    const logger = createFakeLogger()

    await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'web',
        text: 'a question with no mention to rewrite',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(model.calls[0]?.question).toBe(
      'a question with no mention to rewrite'
    )
  })
})
