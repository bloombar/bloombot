/** Test helper: a plausible `InboundMention`, overridable per test. */

import type { InboundMention } from '../../src/dto.js'

export const BOT_ID = 'bot-snowflake-1'

export function inboundMention(
  overrides: Partial<InboundMention> = {}
): InboundMention {
  return {
    guildId: 'guild-1',
    channelName: 'general',
    categoryName: 'Test Category',
    authorId: 'author-1',
    authorDisplayName: 'Test Student',
    authorRoleNames: [],
    text: `<@${BOT_ID}> When is the midterm?`,
    botId: BOT_ID,
    authorIsBot: false,
    ...overrides,
  }
}
