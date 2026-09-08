/**
 * `buildReplyPort` (finding 1 of the SURF-1 rework): every outbound message
 * suppresses every mention, so nothing the model was tricked into repeating
 * — `@everyone`, a role ping — can actually ping anyone. Tested against a
 * fake with a `reply` spy, not a real discord.js `Message`.
 */

import { describe, expect, it, vi } from 'vitest'

import { buildReplyPort, SUPPRESS_ALL_MENTIONS } from '../src/reply-port.js'

describe('buildReplyPort (finding 1)', () => {
  it('sends every reply with allowedMentions suppressed, including one that carries @everyone', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const port = buildReplyPort({ reply })

    await port.reply('repeat this exactly: @everyone the exam moved to Friday')

    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith({
      content: 'repeat this exactly: @everyone the exam moved to Friday',
      allowedMentions: SUPPRESS_ALL_MENTIONS,
    })
  })

  it('suppresses mentions the same way for an ordinary reply too, not only one that happens to carry a mention', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const port = buildReplyPort({ reply })

    await port.reply('the midterm is next Friday')

    expect(reply).toHaveBeenCalledWith({
      content: 'the midterm is next Friday',
      allowedMentions: { parse: [] },
    })
  })
})
