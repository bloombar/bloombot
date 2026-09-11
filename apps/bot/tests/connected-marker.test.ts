/**
 * `startConnectedMarkerHeartbeat` (`connected-marker.ts`) — SURF-9 rework
 * round 2, MF-B's own durable "last known connected" marker, kept current
 * while connected and frozen while not. Exercised against a real throwaway
 * database and fake timers — no real gateway connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { discordGatewayStatus } from '@bloombot/db'

import {
  startConnectedMarkerHeartbeat,
  type ConnectedMarkerHeartbeat,
} from '../src/connected-marker.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase
let heartbeat: ConnectedMarkerHeartbeat | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  heartbeat?.stop()
  heartbeat = undefined
  vi.useRealTimers()
  testDb.cleanup()
})

describe('startConnectedMarkerHeartbeat (SURF-9 rework round 2, MF-B)', () => {
  it('records the current moment on every tick while connected', () => {
    testDb = createTestDatabase()
    const start = Date.now()
    vi.setSystemTime(start)

    heartbeat = startConnectedMarkerHeartbeat(testDb.db, () => true, 60_000)

    vi.advanceTimersByTime(60_000)

    expect(discordGatewayStatus.getLastKnownConnectedAt(testDb.db)).toBe(
      start + 60_000
    )
  })

  it('never advances the marker while not connected — an outage must not be recorded as connected time', () => {
    testDb = createTestDatabase()
    const start = Date.now()
    vi.setSystemTime(start)
    let connected = false

    heartbeat = startConnectedMarkerHeartbeat(
      testDb.db,
      () => connected,
      60_000
    )

    vi.advanceTimersByTime(60_000)
    expect(
      discordGatewayStatus.getLastKnownConnectedAt(testDb.db)
    ).toBeUndefined()

    connected = true
    vi.advanceTimersByTime(60_000)
    expect(discordGatewayStatus.getLastKnownConnectedAt(testDb.db)).toBe(
      start + 120_000
    )
  })

  it('stop() ends the heartbeat — a later tick records nothing further', () => {
    testDb = createTestDatabase()
    const start = Date.now()
    vi.setSystemTime(start)

    heartbeat = startConnectedMarkerHeartbeat(testDb.db, () => true, 60_000)
    vi.advanceTimersByTime(60_000)
    const recordedBeforeStop = discordGatewayStatus.getLastKnownConnectedAt(
      testDb.db
    )

    heartbeat.stop()
    vi.advanceTimersByTime(120_000)

    expect(discordGatewayStatus.getLastKnownConnectedAt(testDb.db)).toBe(
      recordedBeforeStop
    )
  })
})
