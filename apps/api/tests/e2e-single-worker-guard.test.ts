/**
 * QA-9: `e2e/support/require-single-worker.ts` and the two
 * `playwright.config.ts` lines that wire it in as `globalSetup` were
 * previously exercised by no test at all — nothing in `npm test` imported
 * the guard or asserted `workers === 1`, so a mutation to either shipped
 * green while silently reopening the flake `docs/DECISIONS.md`'s D-62
 * diagnosed. Two things, closing that gap directly rather than through the
 * suite it only ever runs inside: the guard function itself, called with
 * the shapes it has to reject and the one it has to accept; and the
 * resolved config, proving `workers: 1` and `globalSetup` are actually the
 * values on disk, not merely present in a comment.
 *
 * Lives in `apps/api/tests`, not a new `vitest.config.ts` project of its
 * own, on purpose (rework finding): a first version of this file added a
 * `root: '.'` project instead, and adding a whole project — not merely a
 * file — measurably changed how vitest's own thread pool schedules every
 * *other* project's files across a full `npm test` run. That surfaced as an
 * unrelated `apps/mcp` security test (a second account's bearer token
 * refused against a session that is not its own) intermittently seeing a
 * 404 instead of the 401 it asserts, on a run this file's own author could
 * not reproduce locally even under deliberately induced CPU load, but that
 * a second reviewer reproduced directly by diffing a worktree with the new
 * project against one without it. Rather than ship a change whose exact
 * mechanism is not fully nailed down, this guard's own two tests moved into
 * an existing project's already-declared `tests/**\/*.test.ts` — `apps/api`,
 * because it is the process `e2e/support/start-api.ts` wraps directly, the
 * one this guard exists to keep reliable — so `vitest.config.ts` itself is
 * unchanged by this fix.
 */

import { describe, expect, it } from 'vitest'

import playwrightConfig from '../../../playwright.config.js'
import requireSingleWorker from '../../../e2e/support/require-single-worker.js'

describe('requireSingleWorker (QA-9)', () => {
  // Anything other than exactly one worker must be refused — not just "more
  // than a handful". A narrower condition (`> 4`, say, mistaken for "the
  // default pool size") would still refuse 8 workers but wave through 2 or
  // 3, which is enough concurrent connections to reproduce D-62's own
  // failure; asserting the boundary values, not only an extreme one, is what
  // catches that mutation.
  it.each([2, 3, 4, 8])(
    'throws when the resolved worker count is %i, not 1',
    (workers) => {
      expect(() =>
        requireSingleWorker({ workers } as Parameters<
          typeof requireSingleWorker
        >[0])
      ).toThrow(/exactly one Playwright worker/)
    }
  )

  it('does not throw when the resolved worker count is 1', () => {
    expect(() =>
      requireSingleWorker({ workers: 1 } as Parameters<
        typeof requireSingleWorker
      >[0])
    ).not.toThrow()
  })
})

describe('playwright.config.ts (QA-9)', () => {
  // Pins the two lines D-62's fix actually depends on. Fails without either:
  // `workers` reverted to Playwright's own unset default, or `globalSetup`
  // pointed anywhere else (or removed), leaves this suite unable to tell the
  // difference between "the guard is wired in" and "the guard exists but
  // nothing calls it".
  it('resolves workers to exactly 1', () => {
    expect(playwrightConfig.workers).toBe(1)
  })

  it('wires require-single-worker.ts in as globalSetup', () => {
    expect(playwrightConfig.globalSetup).toBe(
      './e2e/support/require-single-worker.ts'
    )
  })
})
