/**
 * QA-8's own stand-in `ReplyPort` (`@bloombot/discord`'s `dto.ts`) — records
 * every reply `handleMention` sends rather than posting to a real Discord
 * channel, the same reason there is no discord.js anywhere in this harness
 * (`apps/bot` is out of this slice's scope; see `e2e/course-configuration.spec.ts`'s
 * own module comment).
 */

import type { ReplyPort } from '@bloombot/discord'

export class FakeReplyPort implements ReplyPort {
  sent: string[] = []

  reply(text: string): Promise<void> {
    this.sent.push(text)
    return Promise.resolve()
  }
}
