/**
 * Test helper: a `ReplyPort` (`src/dto.ts`) that records every part it was
 * asked to send, in the order it received them — SURF-5's "sent in order,
 * nothing lost" is asserted by reassembling `sent` in tests, not by trusting
 * `handleMention`'s own account of what it did.
 */

import type { ReplyPort } from '../../src/dto.js'

export interface FakeReplyPort extends ReplyPort {
  sent: string[]
}

export function createFakeReplyPort(): FakeReplyPort {
  const sent: string[] = []
  return {
    sent,
    reply: async (text: string) => {
      sent.push(text)
    },
  }
}
