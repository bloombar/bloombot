/**
 * Test helper: a `Logger` (`@bloombot/logger`) that records calls instead of
 * writing anywhere — `answer.ts` only ever calls `.info`/`.error` on the
 * logger it is handed (CORE-4's "dependencies as arguments"), so this is all
 * a test needs, not a real `pino` instance writing under `LOGS_DIR`.
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
  // `answer.ts` actually calls — cast rather than restate the rest, the same
  // "tests may reach for `any`" allowance the root eslint config grants
  // `packages/*/tests/**/*.ts`.
  return fake as unknown as FakeLogger
}
