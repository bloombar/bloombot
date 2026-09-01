/**
 * Test helper: a `Logger` (`@bloombot/logger`) that records calls instead of
 * writing anywhere — the same shape `packages/discord/tests/helpers/fake-logger.ts`
 * uses, duplicated here for the same reason it duplicates its own siblings.
 */

import { vi } from 'vitest'

import type { Logger } from '@bloombot/logger'

export interface FakeLogger extends Logger {
  infoCalls: unknown[][]
  errorCalls: unknown[][]
}

export function createFakeLogger(): FakeLogger {
  const infoCalls: unknown[][] = []
  const errorCalls: unknown[][] = []

  const fake = {
    infoCalls,
    errorCalls,
    info: vi.fn((...args: unknown[]) => {
      infoCalls.push(args)
    }),
    error: vi.fn((...args: unknown[]) => {
      errorCalls.push(args)
    }),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }

  // `Logger` (pino) is a much larger interface than the handful of levels
  // this API actually calls — cast rather than restate the rest, the same
  // `unknown`-then-`FakeLogger` cast `packages/discord`'s own fake takes.
  return fake as unknown as FakeLogger
}
