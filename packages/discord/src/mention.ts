/**
 * BOT-6 / SURF-2 — recognizing and rewriting a mention of this bot.
 *
 * Discord renders a mention as `<@id>`, or `<@!id>` when the mentioned
 * member has a server nickname — `response_bot.py`'s own rewrite regex
 * (`re.sub(f"<@!?{client.user.id}>", "@Bloombot", message.content)`) already
 * accounts for both, and this matches it exactly rather than trusting a
 * `Message.mentions` list this package never sees (its DTO carries raw
 * text, not a discord.js `Collection`).
 */

/** The bare display name BOT-6 rewrites a mention to, absent an override — `handleMention` prefixes it with `@`. */
export const DEFAULT_BOT_DISPLAY_NAME = 'Bloombot'

/** Escapes a string for safe use inside a `RegExp` — a bot's snowflake is always digits, but nothing here should depend on that staying true. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches `<@botId>` or `<@!botId>`, wherever it appears in a message. */
function mentionPattern(botId: string): RegExp {
  return new RegExp(`<@!?${escapeRegExp(botId)}>`, 'g')
}

/** SURF-2 — does `text` mention `botId` at all? */
export function mentionsBot(text: string, botId: string): boolean {
  // A fresh RegExp per call: the `g` flag makes a shared instance stateful
  // (`.test` advances `lastIndex`), which would make the second call on the
  // same bot id silently wrong.
  return mentionPattern(botId).test(text)
}

/**
 * BOT-6 — rewrite every mention of `botId` in `text` to a readable
 * `@<displayName>`, so the model sees a sentence addressed to a named
 * assistant rather than an opaque numeric id. `text` itself — what the
 * student actually typed — is untouched; this only ever produces the
 * separate `modelText` `answerQuestion` (`@bloombot/core`) is asked with.
 */
export function rewriteMention(
  text: string,
  botId: string,
  displayName: string = DEFAULT_BOT_DISPLAY_NAME
): string {
  return text.replace(mentionPattern(botId), `@${displayName}`)
}
