/** Test helper: a plausible `InboundMention`, overridable per test. */

import type { InboundMention } from '../../src/dto.js'

export const BOT_ID = 'bot-snowflake-1'

/** The default `authorId` every test below gets unless it overrides one — `seed.ts#seedBoundServerWithCourse` connects a person under this snowflake by default (LINK-1), so most tests keep answering exactly as before. */
export const DEFAULT_AUTHOR_ID = 'author-1'

export function inboundMention(
  overrides: Partial<InboundMention> = {}
): InboundMention {
  return {
    guildId: 'guild-1',
    channelName: 'general',
    categoryName: 'Test Category',
    authorId: DEFAULT_AUTHOR_ID,
    authorDisplayName: 'Test Student',
    authorRoleNames: [],
    text: `<@${BOT_ID}> When is the midterm?`,
    botId: BOT_ID,
    authorIsBot: false,
    repliesToBot: false,
    ...overrides,
  }
}
