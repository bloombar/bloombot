/**
 * Test helper: a `ModelClient` (`@bloombot/core`'s `src/ports.ts`) with no
 * network — the same shape `packages/core/tests/helpers/fake-model-client.ts`
 * uses, duplicated here rather than imported across a package boundary test
 * helpers are not published through.
 */

import type { ModelAnswer, ModelClient, ModelRequest } from '@bloombot/core'

export interface FakeModelClientOptions {
  /** The text every successful `ask` resolves with, unless overridden per test. */
  answerText?: string
  upstreamThreadId?: string | null
}

export class FakeModelClient implements ModelClient {
  /** Every request this client received, in call order. */
  calls: ModelRequest[] = []

  private answerText: string
  private upstreamThreadId: string | null
  private nextError: Error | null = null

  constructor(options: FakeModelClientOptions = {}) {
    this.answerText = options.answerText ?? 'a fake answer'
    this.upstreamThreadId = options.upstreamThreadId ?? 'fake-thread-1'
  }

  /** The *next* call to `ask` rejects with `error` instead of answering — CORE-5's failure path. */
  failNext(error: Error = new Error('fake model failure')): void {
    this.nextError = error
  }

  async ask(request: ModelRequest): Promise<ModelAnswer> {
    this.calls.push(request)
    if (this.nextError) {
      const error = this.nextError
      this.nextError = null
      throw error
    }
    return { text: this.answerText, upstreamThreadId: this.upstreamThreadId }
  }
}
