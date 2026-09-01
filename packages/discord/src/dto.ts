/**
 * The inbound shape `handleMention` (`handle-mention.ts`) reads, and the
 * outbound port it writes through — the whole boundary between this package
 * and `apps/bot`'s discord.js client.
 *
 * `apps/bot` is the only place a discord.js `Message` is ever constructed
 * (PLAT-3), so everything worth testing here — routing, person resolution,
 * mention rewriting, splitting, rendering each `AnswerResult` — runs against
 * this plain DTO and port instead, with no gateway connection and no vendor
 * type in sight.
 */

/**
 * One incoming Discord message, reduced to the fields `handleMention` needs.
 *
 * `authorIsBot` is not one of the fields BOT-1/SURF-2's prose names outright,
 * but SURF-2 asks this package to ignore "its own messages and those of
 * other bots" — the *other bots* half is not decidable from `authorId`
 * alone, so it travels here the same way discord.js itself reports it
 * (`Message.author.bot`).
 */
export interface InboundMention {
  /** The Discord server (guild) snowflake the message arrived in — resolved to an organization through the binding record (SURF-3). */
  guildId: string
  /** The channel's own name, carried through for logging (CORE-2's `ArrivalContext.channelName` is not a routing signal either). */
  channelName: string
  /** The name of the category the channel sits in, or `null` for an uncategorized channel or a DM (BOT-3's fallback case). */
  categoryName: string | null
  /** The author's Discord snowflake — resolves to a person through `person_identities` (SURF-4). */
  authorId: string
  /** The author's readable name — a server nickname when they have one, their username otherwise — merged onto the person the first time they are seen (SURF-4) and used to seed the model's own opening item (MDL-4). */
  authorDisplayName: string
  /** The author's Discord role names, the fallback routing signal (BOT-3/BOT-12) when `categoryName` matches no course. */
  authorRoleNames: string[]
  /** What the student actually typed, mention token and all — this is what the transcript records (CORE-1's `text`/`modelText` split). */
  text: string
  /** The bot's own snowflake, as Discord reports it in `<@id>`/`<@!id>` — both the mention this package looks for and the token it rewrites (BOT-6). */
  botId: string
  /** `true` when the message's author is itself a bot account — including this bot, but the self case is checked separately (`authorId === botId`) so its own log line can say which one happened. */
  authorIsBot: boolean
}

/**
 * The outbound port — one method, the same "this is all the pipeline ever
 * needs from it" shape `@bloombot/core`'s `ModelClient` (`ports.ts`) takes.
 *
 * A single `reply(text)` call always posts one Discord message; a long
 * answer is split into more than one call by `handleMention` itself
 * (SURF-5), in order, so this port never has to know about the 2000
 * character limit.
 */
export interface ReplyPort {
  reply(text: string): Promise<void>
}
