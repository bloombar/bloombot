/**
 * Test helper: a `Logger` (`@bloombot/logger`) that records calls instead of
 * writing anywhere — the same helper `packages/core/tests/helpers/fake-logger.ts`
 * defines, duplicated here rather than imported across a package boundary
 * test helpers are not published through.
 */

import { vi } from 'vitest'

import type { Logger } from '@bloombot/logger'

export interface FakeLogger extends Logger {
  infoCalls: unknown[][]
  warnCalls: unknown[][]
  errorCalls: unknown[][]
}

export function createFakeLogger(): FakeLogger {
  const infoCalls: unknown[][] = []
  const warnCalls: unknown[][] = []
  const errorCalls: unknown[][] = []

  const fake = {
    infoCalls,
    warnCalls,
    errorCalls,
    info: vi.fn((...args: unknown[]) => {
      infoCalls.push(args)
    }),
    warn: vi.fn((...args: unknown[]) => {
      warnCalls.push(args)
    }),
    error: vi.fn((...args: unknown[]) => {
      errorCalls.push(args)
    }),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }

  // `Logger` (pino) is a much larger interface than the handful of levels
  // this adapter actually calls — cast rather than restate the rest, the
  // same "tests may reach for `any`" allowance the root eslint config
  // grants `packages/*/tests/**/*.ts`.
  return fake as unknown as FakeLogger
}
