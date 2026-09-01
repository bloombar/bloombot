/**
 * QA-8's own stand-in `ModelClient` (`@bloombot/core`'s `ports.ts`) — no
 * network, a fixed answer. The same shape
 * `packages/discord/tests/helpers/fake-model-client.ts` already uses,
 * duplicated here rather than imported: that file lives under a package's
 * own `tests/`, which is not published through that package's `exports`
 * field (`packages/discord/package.json`) for anything outside it to
 * import, the same reason `e2e/support/file-email-sender.ts` is its own
 * `EmailSender` rather than a reused one.
 *
 * This is the one part of QA-8's own harness that is *not* real: no OpenAI
 * call happens anywhere in this spec. Everything else this spec exercises —
 * the browser, `apps/api`, the database, `packages/discord`'s own
 * `handleMention` — is the genuine article; see that spec's own module
 * comment for the full breakdown of what is real and what is not.
 */

import type { ModelAnswer, ModelClient, ModelRequest } from '@bloombot/core'

export class FakeModelClient implements ModelClient {
  calls: ModelRequest[] = []

  constructor(private readonly answerText: string) {}

  ask(request: ModelRequest): Promise<ModelAnswer> {
    this.calls.push(request)
    return Promise.resolve({
      text: this.answerText,
      upstreamThreadId: 'e2e-fake-thread',
      model: 'e2e-fake-model',
    })
  }
}
