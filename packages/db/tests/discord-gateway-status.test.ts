import { afterEach, describe, expect, it } from 'vitest'

import { discordGatewayStatus } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('discord-gateway-status repo (SURF-9 rework round 2, MF-B)', () => {
  it('is undefined before anything has ever recorded a connected moment', () => {
    testDb = createTestDatabase()
    expect(
      discordGatewayStatus.getLastKnownConnectedAt(testDb.db)
    ).toBeUndefined()
  })

  it('round-trips the recorded moment', () => {
    testDb = createTestDatabase()
    const now = Date.now()

    discordGatewayStatus.recordLastKnownConnected(now, testDb.db)

    expect(discordGatewayStatus.getLastKnownConnectedAt(testDb.db)).toBe(now)
  })

  it('overwrites the single row rather than accumulating history — an older value can never linger after a newer one is recorded', () => {
    testDb = createTestDatabase()
    const first = Date.now() - 60_000
    const second = Date.now()

    discordGatewayStatus.recordLastKnownConnected(first, testDb.db)
    discordGatewayStatus.recordLastKnownConnected(second, testDb.db)

    expect(discordGatewayStatus.getLastKnownConnectedAt(testDb.db)).toBe(second)
  })

  it('accepts an out-of-order write the same way — the marker always reflects the most recent call, not the largest value ever seen', () => {
    testDb = createTestDatabase()
    const later = Date.now()
    const earlier = later - 60_000

    discordGatewayStatus.recordLastKnownConnected(later, testDb.db)
    discordGatewayStatus.recordLastKnownConnected(earlier, testDb.db)

    expect(discordGatewayStatus.getLastKnownConnectedAt(testDb.db)).toBe(
      earlier
    )
  })
})
