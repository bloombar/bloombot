/**
 * SURF-5's other half of "the answer is a reply, and a long answer is split
 * rather than lost" — `response_bot.py:325` posts the model's whole answer
 * in a single `message.channel.send(openai_response)` call, which Discord
 * simply refuses above 2000 characters (a `HTTPException` the Python bot
 * never catches, so that answer is silently never sent at all). This module
 * is the fix: split, never truncate, never drop.
 *
 * See docs/DECISIONS.md for why the boundary below (paragraph, then line,
 * then word, then a hard cut) was chosen over simpler alternatives.
 */

/** Discord's own per-message character limit. */
export const DISCORD_MESSAGE_LIMIT = 2000

/**
 * Find where to cut `text` so the first `limit` characters end on the most
 * readable boundary available: the end of a paragraph, failing that a line,
 * failing that a word, and only as a last resort — a single "word" longer
 * than `limit` itself, with nowhere readable to break it — a hard cut at
 * `limit`. Always returns an index in `(0, limit]`, so the caller's `while`
 * loop in `splitForDiscord` below is guaranteed to make progress.
 */
function findSplitIndex(text: string, limit: number): number {
  const window = text.slice(0, limit)

  const paragraphBreak = window.lastIndexOf('\n\n')
  if (paragraphBreak > 0) return paragraphBreak + 2 // keep both newlines with the part before them

  const lineBreak = window.lastIndexOf('\n')
  if (lineBreak > 0) return lineBreak + 1

  const wordBreak = window.lastIndexOf(' ')
  if (wordBreak > 0) return wordBreak + 1

  return limit
}

/**
 * Split `text` into parts, each at most `limit` characters, on the
 * boundaries `findSplitIndex` chooses. Plain slicing, nothing trimmed or
 * rewritten at the cut — `parts.join('')` always reconstructs `text`
 * exactly, which is SURF-5's "nothing lost" made checkable rather than
 * merely asserted.
 *
 * `text` under the limit is returned as the single part it already is, so a
 * caller never has to special-case "did this actually need splitting".
 */
export function splitForDiscord(
  text: string,
  limit: number = DISCORD_MESSAGE_LIMIT
): string[] {
  if (text.length <= limit) return [text]

  const parts: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    const splitIndex = findSplitIndex(remaining, limit)
    parts.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex)
  }
  if (remaining.length > 0) parts.push(remaining)

  return parts
}
