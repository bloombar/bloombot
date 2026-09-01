/**
 * QA-8's own stand-in `Logger` (`@bloombot/logger`) — `@bloombot/logger`'s
 * real `createLogger` reads `@bloombot/config`'s `CONFIG` (`NODE_ENV`,
 * `PUBLIC_APP_URL`, ...), which is only ever set for the *spawned*
 * `apps/api` process (`playwright.config.ts`'s own `webServer.env`), not for
 * the Playwright test runner process this spec's own Node code (everything
 * after "the browser's own part ends," this file's own module comment)
 * actually executes in. `handleMention` only ever calls `info`/`error`
 * (`packages/discord/src/handle-mention.ts`); this satisfies the rest of
 * the `Logger` interface's shape with no-ops, the same allowance
 * `packages/discord/tests/helpers/fake-logger.ts` takes for its own
 * narrower vitest mock.
 */

import type { Logger } from '@bloombot/logger'

function noop(): void {
  // Nothing to record — QA-8 does not assert on log output, only on
  // `handleMention`'s own return value and the transcript it writes.
}

export function createFakeLogger(): Logger {
  const fake = {
    info: noop,
    error: noop,
    warn: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  }
  // `Logger` (pino) is a much larger interface than the handful of levels
  // `handleMention` actually calls.
  return fake as unknown as Logger
}
