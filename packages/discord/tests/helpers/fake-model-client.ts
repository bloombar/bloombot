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
  /** The model every successful `ask` reports it ran against (COST-1). Defaults to a fixed string. */
  model?: string
  /** Token counts every successful `ask` reports (COST-1/COST-6). `undefined` (the default) simulates a provider that reports no usage at all. */
  usage?: { inputTokens: number; outputTokens: number }
}

export class FakeModelClient implements ModelClient {
  /** Every request this client received, in call order. */
  calls: ModelRequest[] = []

  private answerText: string
  private upstreamThreadId: string | null
  private model: string
  private usage: { inputTokens: number; outputTokens: number } | undefined
  private nextError: Error | null = null

  constructor(options: FakeModelClientOptions = {}) {
    this.answerText = options.answerText ?? 'a fake answer'
    this.upstreamThreadId = options.upstreamThreadId ?? 'fake-thread-1'
    this.model = options.model ?? 'fake-model'
    this.usage = options.usage
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
    return this.usage
      ? {
          text: this.answerText,
          upstreamThreadId: this.upstreamThreadId,
          model: this.model,
          usage: this.usage,
        }
      : {
          text: this.answerText,
          upstreamThreadId: this.upstreamThreadId,
          model: this.model,
        }
  }
}
