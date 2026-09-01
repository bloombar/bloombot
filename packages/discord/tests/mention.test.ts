/**
 * BOT-6 / SURF-2: detecting and rewriting a mention of this bot. Mirrors
 * `response_bot.py`'s own `<@!?id>` regex (`response_bot.py:262`) exactly,
 * both variants Discord renders.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BOT_DISPLAY_NAME,
  mentionsBot,
  rewriteMention,
} from '../src/mention.js'

describe('mentionsBot (SURF-2)', () => {
  it('is true for a plain mention token', () => {
    expect(mentionsBot('<@123> are you there?', '123')).toBe(true)
  })

  it('is true for the nickname-mention variant', () => {
    expect(mentionsBot('<@!123> are you there?', '123')).toBe(true)
  })

  it('is false when the text mentions a different id', () => {
    expect(mentionsBot('<@999> are you there?', '123')).toBe(false)
  })

  it('is false with no mention token at all', () => {
    expect(mentionsBot('are you there?', '123')).toBe(false)
  })

  it('is checked correctly twice in a row against the same bot id', () => {
    // A shared, stateful `RegExp` (the `g` flag advances `lastIndex`) would
    // make the second call against the same text wrongly return `false` —
    // this is the regression `mentionPattern`'s "fresh RegExp per call"
    // comment exists to prevent.
    const text = '<@123> hello'
    expect(mentionsBot(text, '123')).toBe(true)
    expect(mentionsBot(text, '123')).toBe(true)
  })
})

describe('rewriteMention (BOT-6)', () => {
  it('replaces the mention token with the readable default name', () => {
    expect(rewriteMention('<@123> when is the midterm?', '123')).toBe(
      `@${DEFAULT_BOT_DISPLAY_NAME} when is the midterm?`
    )
  })

  it('replaces the nickname-mention variant too', () => {
    expect(rewriteMention('<@!123> hi', '123')).toBe(
      `@${DEFAULT_BOT_DISPLAY_NAME} hi`
    )
  })

  it('uses a supplied display name over the default', () => {
    expect(rewriteMention('<@123> hi', '123', 'CourseBot')).toBe(
      '@CourseBot hi'
    )
  })

  it('leaves text with no mention untouched', () => {
    expect(rewriteMention('no mention here', '123')).toBe('no mention here')
  })
})
