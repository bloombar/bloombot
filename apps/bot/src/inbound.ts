/**
 * Translates one discord.js message — already narrowed to a guild message
 * (`message.inGuild()`, checked by the caller: a DM has no category or roles
 * to route by, BOT-1's own scope) — into `@bloombot/discord`'s
 * `InboundMention` DTO. The only place in this file that reaches into a
 * discord.js `Message`.
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
  botId: string
): InboundMention {
  return {
    guildId: message.guild.id,
    channelName: 'name' in message.channel ? (message.channel.name ?? '') : '',
    categoryName: resolveCategoryName(message.channel),
    authorId: message.author.id,
    // A server nickname when the author has one, their bare username
    // otherwise — the same "readable name" BOT-6 rewrites a mention to.
    authorDisplayName: message.member?.displayName ?? message.author.username,
    authorRoleNames: message.member?.roles.cache.map((role) => role.name) ?? [],
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
