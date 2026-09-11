/**
 * Test helper: a `ModelClient` (`@bloombot/core`'s `src/ports.ts`) with no
 * network — duplicated from
 * `packages/discord/tests/helpers/fake-model-client.ts` rather than imported
 * across a package boundary test helpers are not published through.
 */

import type { ModelAnswer, ModelClient, ModelRequest } from '@bloombot/core'

export class FakeModelClient implements ModelClient {
  /** Every request this client received, in call order. */
  calls: ModelRequest[] = []

  async ask(request: ModelRequest): Promise<ModelAnswer> {
    this.calls.push(request)
    return {
      text: 'a fake answer',
      upstreamThreadId: 'fake-thread-1',
      model: 'fake-model',
    }
  }
}
