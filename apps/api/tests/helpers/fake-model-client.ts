/**
 * A stand-in `ModelClient` (`@bloombot/core`'s `ports.ts`) for this app's
 * own tests — no network, an answer fixed at construction. The same shape
 * `e2e/support/fake-model-client.ts` and
 * `packages/discord/tests/helpers/fake-model-client.ts` already use,
 * duplicated here rather than imported: each lives under its own
 * package/app's `tests/`, not published through anything else's `exports`
 * field, the same reasoning those two files' own module comments give for
 * not sharing a single copy across the app/package boundary.
 */

import type { ModelAnswer, ModelClient, ModelRequest } from '@bloombot/core'

export class FakeModelClient implements ModelClient {
  calls: ModelRequest[] = []

  constructor(private readonly answerText = 'This is a fake answer.') {}

  ask(request: ModelRequest): Promise<ModelAnswer> {
    this.calls.push(request)
    return Promise.resolve({
      text: this.answerText,
      upstreamThreadId: 'test-fake-thread',
      model: 'test-fake-model',
    })
  }
}
