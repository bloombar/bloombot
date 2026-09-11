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
  wouldRouteToAnEnabledCourse,
  type HandleMentionDependencies,
  type HandleMentionResult,
} from './handle-mention.js'

export {
  decideCatchUp,
  catchUpApologyText,
  isHandledOutcome,
  type CatchUpBounds,
  type CatchUpCandidate,
  type CatchUpDecision,
} from './catch-up.js'
