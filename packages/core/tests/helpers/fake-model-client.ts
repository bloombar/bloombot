/**
 * Test helper: a `ModelClient` (`src/ports.ts`) with no network, used to
 * exercise the whole pipeline (CORE-4). Records every call it receives —
 * tests assert both what was sent (CORE-1's routing/instructions plumbing)
 * and, for the over-limit case (CORE-3), that no call was made at all.
 */

import type { ModelAnswer, ModelClient, ModelRequest } from '../../src/ports.js'

export interface FakeModelClientOptions {
  /** The text every successful `ask` resolves with, unless `answerText` is overridden per test. Defaults to a fixed string. */
  answerText?: string
  /** The upstream thread id every successful `ask` resolves with. `null` to simulate a provider that never assigns one. */
  upstreamThreadId?: string | null
  /** The model every successful `ask` reports it ran against (COST-1). Defaults to a fixed string. */
  model?: string
  /** Token counts every successful `ask` reports (COST-1/COST-6). `undefined` (the default) simulates a provider that reports no usage at all. */
  usage?: { inputTokens: number; outputTokens: number }
}

export class FakeModelClient implements ModelClient {
  /** Every request this client received, in call order — read this to assert whether (and how) the pipeline called the model. */
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
