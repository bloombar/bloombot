/**
 * `answerQuestion` (CORE-1, CORE-3, CORE-4, CORE-5, CORE-6) — the whole
 * pipeline exercised against a throwaway `tmp/` database and
 * `FakeModelClient`, never a real network call or `data/`.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { conversations, usage, type Database } from '@bloombot/db'

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
    ).rejects.toThrow(/conversation/)
    expect(model.calls).toHaveLength(0)
  })
})
