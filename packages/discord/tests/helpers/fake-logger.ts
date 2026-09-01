/**
 * Test helper: a `Logger` (`@bloombot/logger`) that records calls instead of
 * writing anywhere — the same shape `packages/core/tests/helpers/fake-logger.ts`
 * and `packages/openai/tests/helpers/fake-logger.ts` use, duplicated here for
 * the same reason they duplicate each other's.
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
  // `handleMention` actually calls — cast rather than restate the rest, the
  // same allowance the root eslint config grants `packages/*/tests/**/*.ts`.
  return fake as unknown as FakeLogger
}
