/**
 * `read-legacy.ts`'s own reader against a synthetic legacy-shaped database
 * (QA-2, QA-3), plus `parseLegacyTimestamp`'s round trip with
 * `legacy-fixture.ts#formatLegacyTimestamp` — the peewee-shaped
 * space-separated, microsecond-precision, timezone-free string.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  openLegacySnapshot,
  parseLegacyTimestamp,
  readLegacyMessages,
  readLegacyUsers,
} from '../src/read-legacy.js'
import {
  createLegacyFixture,
  formatLegacyTimestamp,
  type LegacyFixture,
} from './helpers/legacy-fixture.js'

describe('parseLegacyTimestamp', () => {
  it('round-trips a formatted timestamp back to the same millisecond', () => {
    const ms = Date.UTC(2026, 0, 15, 10, 30, 45, 123)
    const formatted = formatLegacyTimestamp(ms)
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/)
    expect(parseLegacyTimestamp(formatted)).toBe(ms)
  })

  it('parses a value with no fractional seconds at all', () => {
    expect(() => parseLegacyTimestamp('2026-01-15 10:30:45')).not.toThrow()
  })

  it('throws on a value that cannot be parsed as a date', () => {
    expect(() => parseLegacyTimestamp('not a timestamp')).toThrow(/Unparseable/)
  })
})

describe('readLegacyUsers / readLegacyMessages', () => {
  let fixture: LegacyFixture

  afterEach(() => {
    fixture.cleanup()
  })

  it('reads discord_id as text, and every row in insertion order', () => {
    fixture = createLegacyFixture()
    const userId = fixture.insertUser({
      discordId: '900000000000000001',
      email: 'a@b.edu',
    })
    fixture.insertMessage({
      userId,
      content: 'first',
      category: 'Cat',
      channel: 'chan',
      direction: 'from',
    })
    fixture.insertMessage({
      userId,
      content: 'second',
      category: 'Cat',
      channel: 'chan',
      direction: 'to',
    })
    fixture.close()

    const db = openLegacySnapshot(fixture.path)
    const users = readLegacyUsers(db)
    const messages = readLegacyMessages(db)
    db.close()

    expect(users).toHaveLength(1)
    expect(users[0]?.discordId).toBe('900000000000000001')
    expect(typeof users[0]?.discordId).toBe('string')

    expect(messages.map((m) => m.content)).toEqual(['first', 'second'])
    expect(messages.map((m) => m.direction)).toEqual(['from', 'to'])
  })
})
