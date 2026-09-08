/**
 * Test helper: a `Logger` (`@bloombot/logger`) that records calls instead of
 * writing anywhere — duplicated from
 * `packages/jobs/tests/helpers/fake-logger.ts` rather than imported across a
 * package boundary test helpers are not published through (that file's own
 * module comment states the same convention).
 */

import { vi } from 'vitest'

import type { Logger } from '@bloombot/logger'

export interface FakeLogger extends Logger {
  infoCalls: unknown[][]
  errorCalls: unknown[][]
  warnCalls: unknown[][]
}

export function createFakeLogger(): FakeLogger {
  const infoCalls: unknown[][] = []
  const errorCalls: unknown[][] = []
  const warnCalls: unknown[][] = []

  const fake = {
    infoCalls,
    errorCalls,
    warnCalls,
    info: vi.fn((...args: unknown[]) => {
      infoCalls.push(args)
    }),
    error: vi.fn((...args: unknown[]) => {
      errorCalls.push(args)
    }),
    warn: vi.fn((...args: unknown[]) => {
      warnCalls.push(args)
    }),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }

  // `Logger` (pino) is a much larger interface than the handful of levels
  // this package actually calls — cast rather than restate the rest, the
  // same "tests may reach for `any`" allowance the root eslint config
  // grants `packages/*/tests/**/*.ts`.
  return fake as unknown as FakeLogger
}
