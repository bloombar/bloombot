/**
 * `answerQuestion` (CORE-1, CORE-3, CORE-4, CORE-5, CORE-6) — the whole
 * pipeline exercised against a throwaway `tmp/` database and
 * `FakeModelClient`, never a real network call or `data/`.
 */

import { randomUUID } from 'node:crypto'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  conversations,
  costLedger,
  courses,
  organizations,
  people,
  schema,
  usage,
  type Database,
} from '@bloombot/db'
import { createAdmissionGate, type AdmissionGate } from '@bloombot/jobs'

import { answerQuestion } from '../src/answer.js'
import { ModelAskError, type ModelClient } from '../src/ports.js'
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

describe('answerQuestion (COST-1/COST-2): a successful answer writes exactly one ledger row, attributed', () => {
  it('records the organization, course, person, model and tokens', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      model: 'gpt-4o',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    const logger = createFakeLogger()

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q1',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )
    expect(result.kind).toBe('answered')

    // Finding 4 of this rework — this test's own name promises "model and
    // tokens", which the per-course summary alone cannot prove (it has
    // neither field). Read the raw row `answerQuestion` actually wrote.
    const rows = testDb.db.select().from(schema.costLedgerEntries).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.organizationId).toBe(organizationId)
    expect(rows[0]?.courseId).toBe(courseId)
    expect(rows[0]?.personId).toBe(personId)
    expect(rows[0]?.model).toBe('gpt-4o')
    expect(rows[0]?.inputTokens).toBe(100)
    expect(rows[0]?.outputTokens).toBe(50)

    const summary = costLedger.getOrganizationUsageSummary(
      organizationId,
      testDb.db
    )
    expect(summary.courses).toEqual([
      {
        courseId,
        courseTitle: 'Test Course',
        // Default pricing, unconfigured (`answerQuestion`'s own
        // `NO_PRICING_CONFIGURED`): 0 micros, but still a real, attributed
        // row — proven by `callCount` below, not by `costMicros` alone.
        costMicros: 0,
        estimatedCostMicros: 0,
        callCount: 1,
      },
    ])
  })

  it('cannot write a second, unattributed ledger row — the ordinary path always attributes organization, course and person', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q1',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    const row = costLedger.recordCostLedgerEntry(
      organizationId,
      {
        courseId: randomUUID(), // a course that does not exist anywhere
        personId,
        model: 'gpt-4o',
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 1,
        measurement: 'measured',
      },
      testDb.db
    )
    expect(row).toBeUndefined()
  })
})

describe('answerQuestion (COST-6): usage the provider never reported is recorded as an estimate, never a measurement', () => {
  it('estimates tokens and cost from the request/answer text, flagged estimated, when the model reports no usage — never a flat zero (finding 2 of this rework)', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    // `FakeModelClient`'s own default has no `usage` — the same shape
    // `@bloombot/openai`'s own `extractUsage` returns when the provider
    // reports none (MDL-5).
    const model = new FakeModelClient({ model: 'gpt-4o' })
    const logger = createFakeLogger()
    const pricing = {
      rates: {},
      defaultRate: {
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 1_000_000,
      },
    }

    await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q1',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger, pricing }
    )

    const rows = testDb.db.select().from(schema.costLedgerEntries).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.measurement).toBe('estimated')
    // No usage reported, but the question ('q1') and answer
    // (`FakeModelClient`'s own default text) are still in hand —
    // `pricing.ts#computeCost`'s own character-based estimate, not `null`.
    expect(rows[0]?.inputTokens).toBeGreaterThan(0)
    expect(rows[0]?.outputTokens).toBeGreaterThan(0)
    // Priced against that estimate, not the flat `costMicros: 0` this used
    // to record — a cap that sums this column can actually see it.
    expect(rows[0]?.costMicros).toBeGreaterThan(0)
  })

  it('prices an unpriced model against the configured default rate, flagged estimated — not silently zero', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      model: 'some-unlisted-model',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    const logger = createFakeLogger()
    const pricing = {
      rates: {
        'gpt-4o': {
          inputMicrosPerMillionTokens: 111,
          outputMicrosPerMillionTokens: 222,
        },
      },
      defaultRate: {
        inputMicrosPerMillionTokens: 500_000,
        outputMicrosPerMillionTokens: 500_000,
      },
    }

    await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q1',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger, pricing }
    )

    const rows = testDb.db.select().from(schema.costLedgerEntries).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.measurement).toBe('estimated')
    // The default rate, applied to real tokens — not zero.
    expect(rows[0]?.costMicros).toBe(1_000_000) // 500_000 + 500_000
  })
})

describe('answerQuestion (COST-3): an organization at its spending cap is refused before any model call', () => {
  it('refuses with declined-over-cap, calls the model zero times, and charges nothing — under the cap the call proceeds and the ledger grows', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    organizations.setSpendingCap(organizationId, 100, testDb.db)
    const model = new FakeModelClient({
      model: 'gpt-4o',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    const logger = createFakeLogger()
    const day = '2026-01-01'

    // Under the cap (nothing spent yet): the call proceeds and the ledger
    // grows by one row.
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
    expect(
      costLedger.getOrganizationSpentMicros(organizationId, testDb.db)
    ).toBe(0)

    // Push the organization's own recorded spend to (or past) its cap,
    // directly — simulating an organization that has already spent enough.
    costLedger.recordCostLedgerEntry(
      organizationId,
      {
        courseId,
        personId,
        model: 'gpt-4o',
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 100,
        measurement: 'measured',
      },
      testDb.db
    )
    expect(costLedger.hasReachedSpendingCap(organizationId, testDb.db)).toBe(
      true
    )

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
    // Over the cap: refused with the outcome that says so, before any model
    // call — the fake recorded no second call at all.
    expect(second).toEqual({ kind: 'declined-over-cap' })
    expect(model.calls).toHaveLength(1)
    // Nothing charged: the ledger still holds only the two rows already
    // written above (the answered call, and the one recorded directly) —
    // the refusal itself added nothing.
    const summary = costLedger.getOrganizationUsageSummary(
      organizationId,
      testDb.db
    )
    expect(summary.courses[0]?.callCount).toBe(2)
  })

  it('a refusal for the cap does not consume the daily allowance, and a refusal for the allowance does not touch the cap', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { maxRequestsPerDay: 1 }
    )
    organizations.setSpendingCap(organizationId, 1, testDb.db)
    costLedger.recordCostLedgerEntry(
      organizationId,
      {
        courseId,
        personId,
        model: 'gpt-4o',
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 1,
        measurement: 'measured',
      },
      testDb.db
    )
    const model = new FakeModelClient()
    const logger = createFakeLogger()
    const day = '2026-01-01'

    // Already over the cap: refused before the daily allowance is ever
    // touched — the day's count stays at zero, not consumed by a refusal
    // that was never about the daily limit at all.
    const result = await answerQuestion(
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
    expect(result).toEqual({ kind: 'declined-over-cap' })
    expect(model.calls).toHaveLength(0)
    expect(
      usage.getUsageCount(organizationId, courseId, personId, day, testDb.db)
    ).toBe(0)

    // Finding 4 of this rework — the other half of this test's own name: a
    // refusal for the daily allowance must not touch the cap either. A
    // fresh organization, well under its own cap, whose daily allowance is
    // exhausted by the one call above — `declined-over-limit` is returned
    // before `hasReachedSpendingCap` is even read (this file's own module
    // comment: the cap check runs *before* the allowance, so a request that
    // never reaches the allowance check never reaches the cap check either
    // — and, symmetrically, a decline that never ran a model call writes no
    // ledger row for the cap to sum).
    const other = seedCourseAndPerson(testDb.db, { maxRequestsPerDay: 1 })
    organizations.setSpendingCap(other.organizationId, 1_000_000, testDb.db)
    const first = await answerQuestion(
      {
        organizationId: other.organizationId,
        courseId: other.courseId,
        personId: other.personId,
        surface: 'discord',
        text: 'q1',
        day,
      },
      { db: testDb.db, model, logger }
    )
    expect(first.kind).toBe('answered-last-request')
    const spentAfterFirst = costLedger.getOrganizationSpentMicros(
      other.organizationId,
      testDb.db
    )

    const second = await answerQuestion(
      {
        organizationId: other.organizationId,
        courseId: other.courseId,
        personId: other.personId,
        surface: 'discord',
        text: 'q2',
        day,
      },
      { db: testDb.db, model, logger }
    )
    expect(second).toEqual({ kind: 'declined-over-limit' })
    // The refusal itself charged nothing beyond what the one answered call
    // above already recorded — untouched by the decline.
    expect(
      costLedger.getOrganizationSpentMicros(other.organizationId, testDb.db)
    ).toBe(spentAfterFirst)
    expect(
      costLedger.hasReachedSpendingCap(other.organizationId, testDb.db)
    ).toBe(false)
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

  // CONV-4/D-49 rework: a write that `appendMessage`'s own retry cannot
  // recover used to be caught here, logged, and continued past — an
  // answered student with a hole in their transcript, exactly the bug this
  // slice fixes (see `answer.ts`'s own module comment). The two tests
  // below replace `still returns the answer when the reply write fails`
  // and `still asks the model and returns the answer when the inbound
  // write fails`, which asserted that swallowing behaviour directly and
  // now fail against the fix; a third proves a *transient* failure never
  // reaches this far at all — `appendMessage`'s own retry absorbs it
  // first.

  it('throws, and never asks the model, when the inbound write fails', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      answerText: 'never reached',
    })
    const logger = createFakeLogger()

    // The inbound message's own transaction is the first `db.transaction`
    // call `answerQuestion` makes. Not a busy/snapshot code, so
    // `appendMessage`'s own retry does not apply — this fails on the first
    // attempt, the same as a non-transient error genuinely would.
    makeTransactionFailOnce(testDb.db, 1)

    await expect(
      answerQuestion(
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
    ).rejects.toThrow('simulated transaction failure')

    // The model is never asked — CONV-4's own "part of answering, not a
    // side effect of it": a question this platform cannot record is not
    // one this platform answers.
    expect(model.calls).toHaveLength(0)
  })

  it('throws after the model has already answered, when the reply write fails', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      answerText: 'an answer that never reaches the caller',
    })
    const logger = createFakeLogger()

    // The inbound message's own transaction (the first) must succeed, so
    // the failure is isolated to the reply's — the second.
    makeTransactionFailOnce(testDb.db, 2)

    await expect(
      answerQuestion(
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
    ).rejects.toThrow('simulated transaction failure')

    // The model was already asked by the time this write failed — that
    // cost is real and this slice does not undo it (this function's own
    // module comment names it). What it does not do any more is answer the
    // student anyway: the question made it onto the transcript, the reply
    // never did, and nothing here claims otherwise.
    expect(model.calls).toHaveLength(1)
    const conversationId = conversations.findExistingConversation(
      organizationId,
      { courseId, personId, surface: 'discord' },
      testDb.db
    )?.id
    if (!conversationId) throw new Error('conversation was not created')
    const transcript = conversations.getTranscript(
      organizationId,
      conversationId,
      testDb.db
    )
    expect(transcript).toHaveLength(1)
    expect(transcript[0]?.direction).toBe('from_person')
  })

  it('recovers from a transient write conflict and still answers — the failure never reaches the caller', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient({
      answerText: 'answered despite one transient conflict',
    })
    const logger = createFakeLogger()

    // A `SQLITE_BUSY_SNAPSHOT` on the reply's own write — the condition
    // `client.ts`'s own `busy_timeout` does not cover (this file's own
    // module comment). `appendMessage`'s own retry (`repos/conversations.ts`)
    // absorbs exactly one of these before this test's mock lets the real
    // transaction through, so `answerQuestion` never sees it at all.
    const original = testDb.db.transaction.bind(testDb.db)
    let callCount = 0

    ;(testDb.db as any).transaction = (...args: any[]) => {
      callCount += 1
      if (callCount === 2) {
        throw new BetterSqlite3.SqliteError(
          'simulated transient conflict',
          'SQLITE_BUSY_SNAPSHOT'
        )
      }
      return (original as any)(...args)
    }

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'a question whose reply write conflicts once',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(result.kind).toBe('answered')
    if (result.kind === 'answered') {
      expect(result.text).toBe('answered despite one transient conflict')
      const transcript = conversations.getTranscript(
        organizationId,
        result.conversationId,
        testDb.db
      )
      expect(transcript.map((m) => m.direction)).toEqual([
        'from_person',
        'to_person',
      ])
    }
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
    // nothing), so an invalid `personId` used to be caught there, by
    // `reserveUsageSlot`'s own tenant-scoping check. LINK-1's own guard now
    // resolves `person` earlier still (it has to, to read `connectedAt`
    // before admission or the allowance are ever touched), so a foreign
    // `personId` is caught there instead — even earlier, but "still throws,
    // never calls the model" behaviour is unchanged.
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
    ).rejects.toThrow(/person no-such-person does not exist/)
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

describe('answerQuestion (LINK-1): an unconnected person is declined before admission, the allowance or the model', () => {
  it('declines with `not-connected`, calls no model, spends no allowance, and writes nothing', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { connect: false }
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

    expect(result).toEqual({ kind: 'not-connected' })
    // LINK-1: "no model call is made and no allowance is spent."
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
    // No conversation was opened and nothing was recorded to a transcript.
    expect(
      conversations.listConversationsForCourse(
        organizationId,
        courseId,
        testDb.db
      )
    ).toHaveLength(0)
  })

  it('answers once the person is connected', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db,
      { connect: false }
    )
    const model = new FakeModelClient({ answerText: 'an answer' })
    const logger = createFakeLogger()

    // Connect the same way `@bloombot/auth`'s `person-link.ts` does once a
    // proof succeeds — merging a second (throwaway) identity onto the
    // person, which is what actually sets `connectedAt`.
    const other = people.createPerson(organizationId, {}, testDb.db)
    const merged = people.mergePeople(
      organizationId,
      personId,
      other.id,
      testDb.db
    )
    expect(merged?.alreadyMerged).toBe(false)

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

// Finding 1 of the MDL-1 rework (D-16) — `ModelRequest` (`ports.ts`) gained
// `displayName`/`courseTitle`/`personRef` so an adapter can seed a new
// upstream conversation's opening item the way `response_bot.py` does
// (`response_bot.py:262-269`), and this is the one call site that
// populates them.
describe('answerQuestion (finding 1 of the MDL-1 rework): the model is asked with who is asking and which course', () => {
  it("sends the person's display name, the course title, and their identity reference", async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    // `seedCourseAndPerson` gives the person a display name but no
    // identity — added directly here, the same way `packages/db`'s own
    // `people.test.ts` seeds one, so this test controls exactly which
    // surface the identity is on.
    testDb.db
      .insert(schema.personIdentities)
      .values({
        id: randomUUID(),
        organizationId,
        personId,
        surface: 'discord',
        externalId: 'snowflake-1',
        createdAt: Date.now(),
      })
      .run()
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await answerQuestion(
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

    expect(model.calls[0]?.displayName).toBe('Test Student')
    expect(model.calls[0]?.courseTitle).toBe('Test Course')
    expect(model.calls[0]?.personRef).toBe('<@snowflake-1>')
  })

  it('sends `null` for the display name and identity reference when neither is known', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    // Unlike the test above, no roster merge and no identity — the ordinary
    // state of a person PPL-3 just created on demand, with no import ever
    // having run.
    people.overwriteRosterFields(
      organizationId,
      personId,
      { displayName: null },
      testDb.db
    )
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'web', // the person has no identity on this surface
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(model.calls[0]?.displayName).toBeNull()
    expect(model.calls[0]?.personRef).toBeNull()
    // The course title is always in hand regardless (CORE-1 already
    // resolved the course before the model is ever asked).
    expect(model.calls[0]?.courseTitle).toBe('Test Course')
  })
})

// Finding 6 of the MDL-1 rework (D-16) — a `ModelAskError` (`ports.ts`)
// carries the upstream conversation id an adapter already created before a
// turn failed, so this failed turn's own conversation is not orphaned.
describe('answerQuestion (finding 6 of the MDL-1 rework): a conversation id created just before a failure is not lost', () => {
  it('persists the id from a thrown `ModelAskError`, and a later turn resumes it', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient()
    const logger = createFakeLogger()

    // Simulates an adapter that created `conv_new_1` upstream and then
    // failed to answer with it — the failure this finding closes.
    model.failNext(
      new ModelAskError(
        'upstream is down after creating a conversation',
        'conv_new_1'
      )
    )

    const first = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q1',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(first.kind).toBe('failed-with-apology')
    // The id survived the failure — persisted the same way a successful
    // call's own id would be (CONV-1).
    if (first.kind === 'failed-with-apology') {
      expect(
        conversations.getConversation(
          organizationId,
          first.conversationId,
          testDb.db
        )?.upstreamThreadId
      ).toBe('conv_new_1')
    }

    // A second, successful turn is handed `conv_new_1` to resume — not
    // `null` (which would make the adapter create yet another one).
    const second = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q2',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger }
    )

    expect(second.kind).toBe('answered')
    expect(model.calls[1]?.upstreamThreadId).toBe('conv_new_1')
  })

  it('does not touch the stored conversation id when the thrown error carries none', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient()
    model.failNext(new Error('a plain transient failure, no new conversation'))
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
      expect(
        conversations.getConversation(
          organizationId,
          result.conversationId,
          testDb.db
        )?.upstreamThreadId
      ).toBeNull()
    }
  })
})

describe('answerQuestion (JOB-4): admission bounds concurrent model calls', () => {
  it('a request admission never grants costs nothing — no model call, no usage counted, the same "costs nothing" shape declined-over-limit already has', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const model = new FakeModelClient()
    const logger = createFakeLogger()
    const neverGrants: AdmissionGate = {
      acquire: async () => ({ granted: false }),
    }

    const result = await answerQuestion(
      {
        organizationId,
        courseId,
        personId,
        surface: 'discord',
        text: 'q',
        day: '2026-01-01',
      },
      { db: testDb.db, model, logger, admission: neverGrants }
    )

    expect(result).toEqual({ kind: 'declined-busy' })
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

  // JOB-4's own test: with a bound of one, two concurrent answers serialize
  // rather than both calling the model. Driven by a model client this test
  // controls, tracking how many calls are in flight at once.
  it('with a bound of one, two concurrent answers serialize rather than both calling the model at once', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const logger = createFakeLogger()
    const admission = createAdmissionGate({ limit: 1, waitMs: 500 })

    let concurrentCalls = 0
    let maxConcurrentCalls = 0
    const model: ModelClient = {
      ask: async () => {
        concurrentCalls += 1
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls)
        await new Promise((resolve) => setTimeout(resolve, 30))
        concurrentCalls -= 1
        return { text: 'ok', upstreamThreadId: 'thread-1', model: 'fake-model' }
      },
    }

    const deps = { db: testDb.db, model, logger, admission }
    const baseInput = {
      organizationId,
      courseId,
      personId,
      surface: 'discord' as const,
      day: '2026-01-01',
    }

    const [a, b] = await Promise.all([
      answerQuestion({ ...baseInput, text: 'question a' }, deps),
      answerQuestion({ ...baseInput, text: 'question b' }, deps),
    ])

    // Neither call ever saw the other in flight — proof the bound of one
    // actually serialized them, not merely that both eventually answered.
    expect(maxConcurrentCalls).toBe(1)
    expect(a.kind).not.toBe('declined-busy')
    expect(b.kind).not.toBe('declined-busy')
  })

  // JOB-4's own test, the other half: a third caller beyond the wait
  // ceiling is told it could not be served rather than left hanging. A
  // separate, short-ceilinged gate makes this deterministic and fast: one
  // caller holds the slot well past the second caller's own wait ceiling.
  it('a caller beyond the wait ceiling is told it could not be served, and reserves no usage slot', async () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, personId } = seedCourseAndPerson(
      testDb.db
    )
    const logger = createFakeLogger()
    const admission = createAdmissionGate({ limit: 1, waitMs: 20 })

    const model: ModelClient = {
      ask: async () => {
        // Held far longer than the second caller's own 20ms wait ceiling.
        await new Promise((resolve) => setTimeout(resolve, 200))
        return { text: 'ok', upstreamThreadId: 'thread-1', model: 'fake-model' }
      },
    }

    const deps = { db: testDb.db, model, logger, admission }
    const baseInput = {
      organizationId,
      courseId,
      personId,
      surface: 'discord' as const,
      day: '2026-01-01',
    }

    const holding = answerQuestion(
      { ...baseInput, text: 'holds the slot' },
      deps
    )
    // Give the first call a tick to actually acquire the slot before the
    // second one arrives behind it.
    await new Promise((resolve) => setTimeout(resolve, 5))

    const declined = await answerQuestion(
      { ...baseInput, text: 'told, not hanging' },
      deps
    )

    expect(declined).toEqual({ kind: 'declined-busy' })
    // The declined caller reserved nothing (JOB-4 costs nothing, the same
    // as declined-over-limit) — only the holder's own eventual request (if
    // any) could have counted against the day's allowance.
    expect(
      usage.getUsageCount(
        organizationId,
        courseId,
        personId,
        '2026-01-01',
        testDb.db
      )
    ).toBeLessThanOrEqual(1)

    await holding
  })
})
