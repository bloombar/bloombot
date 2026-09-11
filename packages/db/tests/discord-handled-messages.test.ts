import { afterEach, describe, expect, it } from 'vitest'

import { discordHandledMessages } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('discord-handled-messages repo (SURF-9)', () => {
  it('round-trips a handled message id', () => {
    testDb = createTestDatabase()
    const now = Date.now()

    discordHandledMessages.recordHandledMessage(
      {
        messageId: 'msg-1',
        serverId: 'server-1',
        channelId: 'chan-1',
        handledAt: now,
      },
      testDb.db
    )

    expect(discordHandledMessages.isMessageHandled('msg-1', testDb.db)).toBe(
      true
    )
    expect(discordHandledMessages.isMessageHandled('msg-2', testDb.db)).toBe(
      false
    )
    expect(discordHandledMessages.listHandledMessageIds(testDb.db)).toEqual(
      new Set(['msg-1'])
    )
  })

  it('swallows a duplicate insert rather than throwing', () => {
    testDb = createTestDatabase()
    const now = Date.now()

    discordHandledMessages.recordHandledMessage(
      {
        messageId: 'msg-1',
        serverId: 'server-1',
        channelId: 'chan-1',
        handledAt: now,
      },
      testDb.db
    )
    // A crash mid-answer, then a catch-up scan re-handling the same message,
    // must not throw on the second record — the repo's own doc comment.
    expect(() =>
      discordHandledMessages.recordHandledMessage(
        {
          messageId: 'msg-1',
          serverId: 'server-1',
          channelId: 'chan-1',
          handledAt: now + 1,
        },
        testDb.db
      )
    ).not.toThrow()
    expect(discordHandledMessages.listHandledMessageIds(testDb.db)).toEqual(
      new Set(['msg-1'])
    )
  })

  it('prunes rows older than a cutoff, leaving newer ones untouched', () => {
    testDb = createTestDatabase()
    const now = Date.now()

    discordHandledMessages.recordHandledMessage(
      {
        messageId: 'old',
        serverId: 'server-1',
        channelId: 'chan-1',
        handledAt: now - 100,
      },
      testDb.db
    )
    discordHandledMessages.recordHandledMessage(
      {
        messageId: 'new',
        serverId: 'server-1',
        channelId: 'chan-1',
        handledAt: now,
      },
      testDb.db
    )

    const pruned = discordHandledMessages.pruneHandledMessagesOlderThan(
      now - 50,
      testDb.db
    )

    expect(pruned).toBe(1)
    expect(discordHandledMessages.listHandledMessageIds(testDb.db)).toEqual(
      new Set(['new'])
    )
  })

  // SURF-9 rework, MF2 — `runCatchUp`'s own scan-window floor.
  describe('maxHandledAt', () => {
    it('is undefined for an empty table', () => {
      testDb = createTestDatabase()
      expect(discordHandledMessages.maxHandledAt(testDb.db)).toBeUndefined()
    })

    it('is the most recent handledAt across every row, not the most recently inserted', () => {
      testDb = createTestDatabase()
      const now = Date.now()

      // Inserted out of chronological order on purpose — this must read the
      // maximum value, not merely the last row written.
      discordHandledMessages.recordHandledMessage(
        {
          messageId: 'newest',
          serverId: 'server-1',
          channelId: 'chan-1',
          handledAt: now,
        },
        testDb.db
      )
      discordHandledMessages.recordHandledMessage(
        {
          messageId: 'oldest',
          serverId: 'server-1',
          channelId: 'chan-1',
          handledAt: now - 100,
        },
        testDb.db
      )

      expect(discordHandledMessages.maxHandledAt(testDb.db)).toBe(now)
    })
  })
})
