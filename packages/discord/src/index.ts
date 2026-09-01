/** Public surface of `@bloombot/discord`. */

export type { InboundMention, ReplyPort } from './dto.js'

export {
  DEFAULT_BOT_DISPLAY_NAME,
  mentionsBot,
  rewriteMention,
} from './mention.js'

export { DISCORD_MESSAGE_LIMIT, splitForDiscord } from './split.js'

export {
  handleMention,
  type HandleMentionDependencies,
  type HandleMentionResult,
} from './handle-mention.js'
