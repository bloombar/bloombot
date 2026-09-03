/**
 * QA-9's own enforcement: refuses to run the suite at all unless it will run
 * with exactly one Playwright worker.
 *
 * `playwright.config.ts`'s `workers: 1` is the fix for the suite's own
 * flake — confirmed by reproducing it first (`docs/DECISIONS.md`'s record of
 * this slice): every spec file that seeds or asserts through its own direct
 * `openDatabase(E2E_DATABASE_PATH)` call (`course-configuration.spec.ts` and
 * several others) is a second, independent connection to the one SQLite file
 * `start-api.ts`'s single long-running API process also holds open: with more
 * than one worker, two of those connections — the API's and a concurrently
 * running spec's own — end up committing at the same moment, and SQLite
 * answers one of them `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT` (the latter not
 * fixed by raising `busy_timeout`: a snapshot invalidated by a concurrent
 * commit is not a lock to wait out, it is a transaction that has to restart).
 * `workers: 1` removes *that* concurrency — separate spec files no longer
 * run at the same time — but not the two-connections-on-one-file design
 * itself: `roster-import-panel.spec.ts` and `course-knowledge-files.spec.ts`
 * each hold their own `openDatabase` handle open across browser interactions
 * that drive real API writes, so a residual, single-spec window remains
 * (D-62, `docs/DECISIONS.md`, records it plainly rather than letting this
 * comment claim more than `workers: 1` actually closes).
 *
 * `workers: 1` alone is silent if a future edit raises it back
 * (`--workers=N` on the command line overrides the config file exactly as
 * easily as editing it, and neither leaves a trace beyond this file's own
 * check) — a contributor chasing a slow suite has every reason to try
 * raising it and no reason to know this history. This `globalSetup` reads
 * back Playwright's own *resolved* worker count — after every CLI override —
 * and refuses to run at all if it is not `1`, so lifting the limit fails on
 * the very first run rather than reintroducing an intermittent failure that
 * looks unrelated to the change that caused it.
 */

import type { FullConfig } from '@playwright/test'

export default function requireSingleWorker(config: FullConfig): void {
  if (config.workers !== 1) {
    throw new Error(
      `QA-9: this suite must run with exactly one Playwright worker, not ${config.workers}. ` +
        'Multiple workers drive concurrent connections to the same e2e SQLite file ' +
        '(several specs open their own alongside the single API process’s), which ' +
        // D-62 (docs/DECISIONS.md): an independent reviewer's larger sample
        // (3 failures in 16 runs, at the commit before this guard existed)
        // measured this at roughly 19% of runs — not the "roughly one run
        // in three" this file's own comment first said, before that
        // measurement corrected it.
        'reproduces SQLITE_BUSY/SQLITE_BUSY_SNAPSHOT in roughly 19% of runs — see ' +
        'playwright.config.ts’s `workers: 1` comment and docs/DECISIONS.md.'
    )
  }
}
