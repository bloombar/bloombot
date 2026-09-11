/**
 * Translates one discord.js message — already narrowed to a guild message
 * (`message.inGuild()`, checked by the caller: a DM has no category or roles
 * to route by, BOT-1's own scope) — into `@bloombot/discord`'s
 * `InboundMention` DTO. The only place in this file that reaches into a
 * discord.js `Message`.
 *
 * SURF-9 rework round 2, MF-D — `buildInboundMention`'s third parameter lets
 * a caller supply the author's `GuildMember` explicitly, overriding
 * `message.member`. The live gateway event (`Events.MessageCreate`) always
 * carries a real member, so `message-handler.ts`'s own call never passes a
 * third argument and this defaults to exactly what it read before. A
 * REST-fetched message (`apps/bot/src/catch-up.ts`'s own scan) carries no
 * `member` payload at all — `message.member` is `null` for any author
 * outside the gateway's own member cache, which is routine above 50
 * members — and reading `authorRoleNames: []` off that silently breaks a
 * role-routed course: `catch-up.ts` resolves the real member itself
 * (`guild.members.fetch`, cached) and passes it here rather than trusting
 * `message.member`.
 */

import type { Message } from 'discord.js'

import type { InboundMention } from '@bloombot/discord'

type GuildMessage = Message<true>

/**
 * Finding 6 of the SURF-1 rework: a thread's own `.parent` is the parent
 * *channel* it hangs off (a `TextChannel`/`ForumChannel`/...), not the
 * category that channel sits in — the category is one level further up,
 * through the parent channel's own `.parent`. Reading `channel.parent?.name`
 * directly, as this used to, gave a thread's own name (or the parent
 * channel's, depending on discord.js's cache) instead, so a question asked
 * in a thread routed by role alone, or not at all in a category-routed
 * server. A non-thread channel's category is unaffected — already one level
 * up.
 */
function resolveCategoryName(channel: GuildMessage['channel']): string | null {
  if (channel.isThread()) {
    return channel.parent?.parent?.name ?? null
  }
  return 'parent' in channel ? (channel.parent?.name ?? null) : null
}

export function buildInboundMention(
  message: GuildMessage,
  botId: string,
  member: GuildMessage['member'] = message.member
): InboundMention {
  return {
    guildId: message.guild.id,
    channelName: 'name' in message.channel ? (message.channel.name ?? '') : '',
    categoryName: resolveCategoryName(message.channel),
    authorId: message.author.id,
    // A server nickname when the author has one, their bare username
    // otherwise — the same "readable name" BOT-6 rewrites a mention to.
    authorDisplayName: member?.displayName ?? message.author.username,
    authorRoleNames: member?.roles.cache.map((role) => role.name) ?? [],
    text: message.content,
    botId,
    authorIsBot: message.author.bot,
    // Finding 3 — a Discord Reply carries no `<@id>` token in its own text;
    // `repliedUser` is Discord's own record of who a reply is addressed to,
    // independent of whether the reply happens to @-ping them, and is
    // already populated on the `messageCreate` event with no extra fetch.
    repliesToBot: message.mentions.repliedUser?.id === botId,
  }
}
