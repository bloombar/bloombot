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
  /** Finding 4 of the TEN-4..6 rework — `routes/discord-servers.ts`'s own token-exchange refusal logs here, not to `errorCalls`, so a test can tell the two apart. */
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
  // this API actually calls — cast rather than restate the rest, the same
  // `unknown`-then-`FakeLogger` cast `packages/discord`'s own fake takes.
  return fake as unknown as FakeLogger
}
