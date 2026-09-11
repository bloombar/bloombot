/**
 * SURF-9 — `decideCatchUp`'s whole policy, exercised as a pure function: no
 * database, no discord.js, no clock. Each test fails without the code it
 * names.
 */

import { describe, expect, it } from 'vitest'

import {
  decideCatchUp,
  isHandledOutcome,
  type CatchUpBounds,
  type CatchUpCandidate,
} from '../src/catch-up.js'
import {
  BOT_ID,
  DEFAULT_AUTHOR_ID,
  inboundMention,
} from './helpers/fixtures.js'

const NOW = 1_800_000_000_000
const BOUNDS: CatchUpBounds = {
  answerMaxAgeMs: 600_000,
  lookbackMs: 86_400_000,
}

function candidate(
  overrides: Partial<CatchUpCandidate> = {}
): CatchUpCandidate {
  return {
    messageId: 'msg-1',
    createdAt: NOW,
    mention: inboundMention(),
    ...overrides,
  }
}

describe('decideCatchUp (SURF-9)', () => {
  it('answers a missed message younger than answerMaxAgeMs', () => {
    const c = candidate({ createdAt: NOW - 1000 })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('answer')
  })

  it('apologises to a missed message older than answerMaxAgeMs but within lookbackMs', () => {
    const c = candidate({ createdAt: NOW - BOUNDS.answerMaxAgeMs - 1000 })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('apologise')
  })

  it('skips a missed message older than lookbackMs entirely', () => {
    const c = candidate({ createdAt: NOW - BOUNDS.lookbackMs - 1000 })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('skip')
  })

  // Boundaries exercised explicitly, per the brief.
  it('answers exactly at the answerMaxAgeMs boundary (age === answerMaxAgeMs)', () => {
    const c = candidate({ createdAt: NOW - BOUNDS.answerMaxAgeMs })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('answer')
  })

  it('apologises exactly at the lookbackMs boundary (age === lookbackMs)', () => {
    const c = candidate({ createdAt: NOW - BOUNDS.lookbackMs })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('apologise')
  })

  it('skips one tick past the lookbackMs boundary', () => {
    const c = candidate({ createdAt: NOW - BOUNDS.lookbackMs - 1 })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('skip')
  })

  it('skips an id already recorded as handled — no double answer', () => {
    const c = candidate({ messageId: 'already-handled', createdAt: NOW - 1000 })
    const [decision] = decideCatchUp(
      [c],
      new Set(['already-handled']),
      NOW,
      BOUNDS
    )
    expect(decision?.kind).toBe('skip')
  })

  it('skips a message that does not address the bot', () => {
    const c = candidate({
      createdAt: NOW - 1000,
      mention: inboundMention({ text: 'no mention here', repliesToBot: false }),
    })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('skip')
  })

  it('skips the bot addressing itself', () => {
    const c = candidate({
      createdAt: NOW - 1000,
      mention: inboundMention({ authorId: BOT_ID }),
    })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('skip')
  })

  it('skips another bot mentioning this bot', () => {
    const c = candidate({
      createdAt: NOW - 1000,
      mention: inboundMention({ authorIsBot: true }),
    })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('skip')
  })

  it('answers a reply to the bot with no <@id> token, exactly as live', () => {
    const c = candidate({
      createdAt: NOW - 1000,
      mention: inboundMention({ text: 'thanks!', repliesToBot: true }),
    })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('answer')
  })

  it('processes candidates oldest first, regardless of input order', () => {
    const older = candidate({
      messageId: 'older',
      createdAt: NOW - 5000,
      mention: inboundMention({ authorId: DEFAULT_AUTHOR_ID }),
    })
    const newer = candidate({
      messageId: 'newer',
      createdAt: NOW - 1000,
      mention: inboundMention({ authorId: DEFAULT_AUTHOR_ID }),
    })
    const decisions = decideCatchUp([newer, older], new Set(), NOW, BOUNDS)
    expect(decisions.map((d) => d.candidate.messageId)).toEqual([
      'older',
      'newer',
    ])
  })

  it('lookbackMs = 0 disables the scan — every candidate skips regardless of age', () => {
    const c = candidate({ createdAt: NOW })
    const decisions = decideCatchUp([c], new Set(), NOW, {
      answerMaxAgeMs: 600_000,
      lookbackMs: 0,
    })
    expect(decisions.map((d) => d.kind)).toEqual(['skip'])
  })

  // SURF-9 rework, D-100 — clock skew between this process and the machine
  // that timestamped a message (or, more mundanely, a candidate built from
  // a `createdAt` that is momentarily ahead of this run's own `now`) yields
  // a negative age. `age <= answerMaxAgeMs` is still true for a negative
  // age, so this must decide `answer`, not throw, not treat a negative
  // number as somehow "older" than the lookback.
  it('a future createdAt (clock skew) yields a negative age and still decides answer', () => {
    const c = candidate({ createdAt: NOW + 5_000 })
    const [decision] = decideCatchUp([c], new Set(), NOW, BOUNDS)
    expect(decision?.kind).toBe('answer')
  })
})

describe('isHandledOutcome (SURF-9)', () => {
  it('is false for the three outcomes that never reached this message at all', () => {
    expect(isHandledOutcome('ignored-self')).toBe(false)
    expect(isHandledOutcome('ignored-other-bot')).toBe(false)
    expect(isHandledOutcome('ignored-not-a-mention')).toBe(false)
  })

  it('is true for every other outcome', () => {
    expect(isHandledOutcome('unbound-server')).toBe(true)
    expect(isHandledOutcome('unrouted')).toBe(true)
    expect(isHandledOutcome('not-configured')).toBe(true)
    expect(isHandledOutcome('invited-to-connect')).toBe(true)
    expect(isHandledOutcome('answered')).toBe(true)
    expect(isHandledOutcome('failed-with-apology')).toBe(true)
  })
})
