/**
 * `onMessageCreate` (`message-handler.ts`) — SURF-9's own recording half of
 * the live path: every outcome `handleMention` can return except the three
 * "never actually reached this message" ones is recorded to
 * `discord_handled_messages`, so a later catch-up scan never re-answers it.
 * Exercised against a real throwaway database and a fake model client — no
 * discord.js gateway connection.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createAdmissionGate } from '@bloombot/jobs'
import { discordHandledMessages } from '@bloombot/db'

import { onMessageCreate } from '../src/message-handler.js'
import { fakeMessage } from './helpers/fake-discord.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { FakeModelClient } from './helpers/fake-model-client.js'
import { seedBoundServerWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** `onMessageCreate`'s own dependencies, minus `botId`/`db`, which each test supplies. */
function baseDeps(testDatabase: TestDatabase, botId: string) {
  return {
    botId,
    botDisplayName: 'Bloombot',
    db: testDatabase.db,
    model: new FakeModelClient(),
    logger: createFakeLogger(),
    admission: createAdmissionGate({ limit: 5, waitMs: 1000 }),
    pricing: {
      rates: {},
      defaultRate: {
        inputMicrosPerMillionTokens: 0,
        outputMicrosPerMillionTokens: 0,
      },
    },
    connectUrl: 'https://app.bloombot.test',
    catchUpEnabled: true,
  }
}

describe('onMessageCreate (SURF-9)', () => {
  it('records the handled id for an outcome that actually reached this message (answered)', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const botId = 'bot-1'
    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: `<@${botId}> when is the midterm?`,
    })

    await onMessageCreate(message, baseDeps(testDb, botId))

    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      true
    )
  })

  it('records the handled id for a silent, but still "handled", outcome (unrouted)', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const botId = 'bot-1'
    // Addresses the bot, but in a category no course routes to.
    const message = fakeMessage({
      guildId,
      categoryName: 'Not A Real Category',
      content: `<@${botId}> hello?`,
    })

    await onMessageCreate(message, baseDeps(testDb, botId))

    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      true
    )
  })

  it('does not record the id when the message is the bot addressing itself', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const botId = 'bot-1'
    const message = fakeMessage({ guildId, authorId: botId })

    await onMessageCreate(message, baseDeps(testDb, botId))

    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      false
    )
  })

  it('does not record the id when the message is another bot', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const botId = 'bot-1'
    const message = fakeMessage({ guildId, authorIsBot: true })

    await onMessageCreate(message, baseDeps(testDb, botId))

    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      false
    )
  })

  it('does not record the id when the message does not mention the bot at all', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const botId = 'bot-1'
    const message = fakeMessage({ guildId, content: 'no mention here' })

    await onMessageCreate(message, baseDeps(testDb, botId))

    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      false
    )
  })

  // SURF-9 rework cheap-fix — recording exists only to dedup against a
  // catch-up scan; with catch-up disabled, nothing reads it.
  it('does not record the id when catch-up is disabled (catchUpEnabled: false)', async () => {
    testDb = createTestDatabase()
    const { guildId } = seedBoundServerWithCourse(testDb.db, {
      categoryName: 'Week 1',
    })
    const botId = 'bot-1'
    const message = fakeMessage({
      guildId,
      categoryName: 'Week 1',
      content: `<@${botId}> when is the midterm?`,
    })

    await onMessageCreate(message, {
      ...baseDeps(testDb, botId),
      catchUpEnabled: false,
    })

    expect(discordHandledMessages.isMessageHandled(message.id, testDb.db)).toBe(
      false
    )
  })
})
