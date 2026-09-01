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

  // Finding 12 — a hard cut at exactly `limit` can land between the two
  // UTF-16 code units of one emoji (a surrogate pair); each half then
  // renders as U+FFFD once it reaches anything that encodes to UTF-8. The
  // leading 'a' offsets every emoji's pair by one code unit, so a naive cut
  // at 2000 lands exactly between the high and low surrogate of the 1000th
  // emoji.
  it('backs off a hard cut that would land between a surrogate pair', () => {
    const text = 'a' + '\u{1F600}'.repeat(1500)
    const parts = splitForDiscord(text, 2000)

    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/) // no part ends mid-pair
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]/) // no part starts mid-pair
    }
    // No fence involved here, so this case stays perfectly lossless — only
    // the *position* of the cut moved, nothing was inserted.
    expect(parts.join('')).toBe(text)
  })

  // Finding 12 — a code fence split across two parts renders broken in
  // Discord: the first message's code block never closes, and the second
  // opens with a stray closing marker and no opener of its own. This is
  // exactly the class of answer this splitter has to handle well: a CS
  // course's long answers are usually code.
  describe('a code fence split across two parts (finding 12)', () => {
    const opening = '```\n'
    const codeLine = 'x'.repeat(30)
    const closingAndAfter = '```\nDone.'
    const text = opening + codeLine + closingAndAfter

    it('renders every part with a balanced (even) number of fence markers', () => {
      const parts = splitForDiscord(text, 20)

      expect(parts.length).toBeGreaterThan(1)
      for (const part of parts) {
        const fenceCount = (part.match(/```/g) ?? []).length
        expect(fenceCount % 2).toBe(0)
      }
    })

    it('keeps every part within the limit even after the synthetic fence markers are added', () => {
      const parts = splitForDiscord(text, 20)
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(20)
      }
    })

    it('loses no actual content — stripping fence markers and whitespace recovers the same code and prose', () => {
      const parts = splitForDiscord(text, 20)
      const stripFencesAndWhitespace = (value: string) =>
        value.replace(/```/g, '').replace(/\s+/g, '')

      expect(stripFencesAndWhitespace(parts.join(''))).toBe(
        stripFencesAndWhitespace(text)
      )
    })

    // The re-split-for-overflow branch can also land back on "no fence was
    // ever open" once the boundary moves earlier — here the retry drops the
    // marker out of the first part entirely, so nothing synthetic is added
    // at all and this stays perfectly lossless.
    it('adds nothing when the re-split for overflow room lands before the fence marker entirely', () => {
      const marker = 'x'.repeat(13) + '```' + 'y'.repeat(10)
      const parts = splitForDiscord(marker, 16)

      expect(parts).toEqual(['x'.repeat(12), 'x' + '```' + 'y'.repeat(10)])
      expect(parts.join('')).toBe(marker)
    })

    it('reproduces exact parts for one hand-checkable example', () => {
      // A fully worked example, not just the invariants above: the fence
      // opens in part 0 (closed immediately, since the fence itself already
      // fills the line-break boundary chosen there), stays open across the
      // two full parts of code, and the original closing fence in `text`
      // supplies the real close in the final part.
      expect(splitForDiscord(text, 20)).toEqual([
        '```\n\n```',
        '```\n' + 'x'.repeat(12) + '\n```',
        '```\n' + 'x'.repeat(12) + '\n```',
        '```\n' + 'x'.repeat(6) + '```\nDone.',
      ])
    })

    it('does not fire when there is no code fence at all — ordinary splitting is unaffected', () => {
      const plainText = 'x'.repeat(30) + ' end of prose'
      const parts = splitForDiscord(plainText, 20)
      // No fence markers anywhere, so nothing synthetic is ever added:
      // losslessness holds exactly, the same as every other ordinary case.
      expect(parts.join('')).toBe(plainText)
    })
  })
})
