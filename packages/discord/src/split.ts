/**
 * SURF-5's other half of "the answer is a reply, and a long answer is split
 * rather than lost" — `response_bot.py:325` posts the model's whole answer
 * in a single `message.channel.send(openai_response)` call, which Discord
 * simply refuses above 2000 characters (a `HTTPException` the Python bot
 * never catches, so that answer is silently never sent at all). This module
 * is the fix: split, never truncate, never drop.
 *
 * See docs/DECISIONS.md for why the boundary below (paragraph, then line,
 * then word, then a hard cut) was chosen over simpler alternatives, and for
 * finding 12 of this slice's rework — closing and reopening a code fence
 * split across two parts, and backing a hard cut off a surrogate pair — both
 * below.
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

  // Finding 12 — a hard cut exactly at `limit` can land between the two
  // UTF-16 code units of one surrogate-pair character (most often an emoji):
  // `String.slice` has no idea the pair belongs together, so each half
  // renders on its own as U+FFFD once it reaches anything that encodes to
  // UTF-8 (Discord's own API included). Backing off one code unit keeps the
  // pair whole in the *next* part instead.
  const endsOnHighSurrogate =
    limit > 0 &&
    text.charCodeAt(limit - 1) >= 0xd800 &&
    text.charCodeAt(limit - 1) <= 0xdbff
  return endsOnHighSurrogate ? limit - 1 : limit
}

/** A code fence's own marker — three backticks, with no language tag reopened (finding 12 keeps the reopen simple rather than tracking which language, if any, was open). */
const FENCE_MARKER = '```'
const FENCE_CLOSE = `\n${FENCE_MARKER}`
const FENCE_OPEN = `${FENCE_MARKER}\n`

/** How many (non-overlapping) fence markers `text` contains — each one toggles whether a code fence is open. */
function fenceMarkerCount(text: string): number {
  return (text.match(/```/g) ?? []).length
}

/** Whether a fence is still open after `part`, given it was (or was not) already open before it — an odd count of markers in `part` flips the state, an even count leaves it. */
function fenceOpenAfter(wasOpen: boolean, part: string): boolean {
  const opensOrCloses = fenceMarkerCount(part) % 2 === 1
  return opensOrCloses ? !wasOpen : wasOpen
}

/**
 * Split `text` into parts, each at most `limit` characters, on the
 * boundaries `findSplitIndex` chooses. Ordinarily plain slicing, nothing
 * trimmed or rewritten at the cut — `parts.join('')` reconstructs `text`
 * exactly, which is SURF-5's "nothing lost" made checkable rather than
 * merely asserted.
 *
 * Finding 12's one exception: when a cut would land inside an open code
 * fence — a real risk here, since a long answer in a CS course is often
 * code — the fence is closed at the end of the part that opened it and
 * reopened at the start of the next, so each individual Discord message
 * renders its own code block correctly instead of one that never closes and
 * a stray closing marker with no opener right after it. This is the one case
 * where `parts.join('')` no longer reproduces `text` byte for byte (two
 * synthetic markers are inserted at the seam); see docs/DECISIONS.md D-17's
 * "Limits" for what that trade-off is and is not.
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
  // True once a part has ended with an odd number of fence markers open —
  // composed by XOR across parts, so it stays correct however many times a
  // fence opens and closes again within one part.
  let insideFence = false

  while (remaining.length > limit) {
    const openPrefix = insideFence ? FENCE_OPEN : ''

    // Reserve room for the reopening marker up front (its length is known
    // before anything else is); whether a closing marker is also needed
    // depends on what ends up in this part, checked below.
    let splitIndex = findSplitIndex(remaining, limit - openPrefix.length)
    let rawPart = remaining.slice(0, splitIndex)
    let willBeInsideFence = fenceOpenAfter(insideFence, rawPart)
    let closeSuffix = willBeInsideFence ? FENCE_CLOSE : ''

    // The boundary `findSplitIndex` already chose does not fit once the
    // closing marker is added too — re-split within a margin that reserves
    // room for both rather than overflow Discord's own limit.
    if (openPrefix.length + rawPart.length + closeSuffix.length > limit) {
      splitIndex = findSplitIndex(
        remaining,
        limit - openPrefix.length - FENCE_CLOSE.length
      )
      rawPart = remaining.slice(0, splitIndex)
      willBeInsideFence = fenceOpenAfter(insideFence, rawPart)
      closeSuffix = willBeInsideFence ? FENCE_CLOSE : ''
    }

    parts.push(openPrefix + rawPart + closeSuffix)
    remaining = remaining.slice(splitIndex)
    insideFence = willBeInsideFence
  }
  if (remaining.length > 0) {
    parts.push(insideFence ? FENCE_OPEN + remaining : remaining)
  }

  return parts
}
