/**
 * SURF-5: a long answer is split, never truncated and never dropped —
 * `response_bot.py:325`'s `message.channel.send(openai_response)` has no
 * such guard, so an answer over Discord's 2000 character limit fails to
 * send at all (see the brief's "Read first" note and docs/DECISIONS.md).
 * These tests fail without `splitForDiscord` — there is nothing else in the
 * package that would produce more than one part.
 */

import { describe, expect, it } from 'vitest'

import { DISCORD_MESSAGE_LIMIT, splitForDiscord } from '../src/split.js'

describe('splitForDiscord (SURF-5)', () => {
  it('returns the text unchanged, as a single part, when it is already under the limit', () => {
    const text = 'A short answer.'
    expect(splitForDiscord(text)).toEqual([text])
  })

  it('splits text over the limit into more than one part, each within the limit', () => {
    const text = 'a'.repeat(2500)
    const parts = splitForDiscord(text)

    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    }
  })

  it('loses nothing — the parts rejoin into exactly the original text', () => {
    const text = 'a'.repeat(2500)
    const parts = splitForDiscord(text)
    expect(parts.join('')).toBe(text)
  })

  it('prefers a paragraph break over a mid-paragraph word break', () => {
    const paragraph1 = 'x'.repeat(1500)
    const paragraph2 = 'y'.repeat(1500)
    const text = `${paragraph1}\n\n${paragraph2}`

    const parts = splitForDiscord(text, 1600)

    expect(parts[0]).toBe(`${paragraph1}\n\n`)
    expect(parts[1]).toBe(paragraph2)
    expect(parts.join('')).toBe(text)
  })

  it('falls back to a word boundary when there is no paragraph or line break nearby', () => {
    const text = `${'word '.repeat(400)}tail`
    const parts = splitForDiscord(text, 1000)

    for (const part of parts.slice(0, -1)) {
      // Every part but the last ends right after a space — no word was cut
      // in half.
      expect(part.endsWith(' ')).toBe(true)
    }
    expect(parts.join('')).toBe(text)
  })

  it('hard-cuts at the limit when a single token has no whitespace to break on at all', () => {
    const text = 'a'.repeat(3000)
    const parts = splitForDiscord(text, 1000)

    expect(parts).toEqual([
      'a'.repeat(1000),
      'a'.repeat(1000),
      'a'.repeat(1000),
    ])
  })
})
