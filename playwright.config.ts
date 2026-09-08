/**
 * Playwright config for QA-7: "at least one test drives a real browser
 * against a real front end, a real API and a real database."
 *
 * `webServer` starts both processes this suite needs and tears them down
 * when the run ends — neither is the process a developer runs day to day
 * (`npm run bot:dev`, `apps/api`'s own `start` script): the API is started
 * from `e2e/support/start-api.ts` (a real `apps/api`, wired with
 * `FileEmailSender` instead of production's `LoggingEmailSender` — see that
 * file's module comment for why), and the web server is the *built*
 * production bundle (`vite preview`, not `vite dev`) — QA-2's own "the real
 * production web build," not a dev-server transform of it.
 *
 * `npm run pree2e` (an npm lifecycle hook `npm run e2e` runs automatically)
 * builds every workspace package and the web bundle first — both processes
 * below import compiled workspace packages by bare specifier
 * (`@bloombot/db` et al.), so a stale or missing `dist/` would either fail
 * to start or silently test old code.
 */

import { defineConfig } from '@playwright/test'

import {
  E2E_ADMIN_EMAIL,
  E2E_API_ORIGIN,
  E2E_API_PORT,
  E2E_PUBLIC_APP_URL,
  E2E_WEB_PORT,
} from './e2e/support/env.js'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // QA-9: `workers: 1`, not merely `fullyParallel: false` above. That
  // setting only serialises tests *within* one spec file — with no
  // `workers` limit, Playwright's default pool still runs separate spec
  // files concurrently, in separate worker processes, all driving the one
  // `apps/api` process from `e2e/support/start-api.ts` against the one
  // SQLite file at `E2E_DATABASE_PATH`. Several specs (`course-configuration
  // .spec.ts` among them) also open their *own* direct
  // `openDatabase(E2E_DATABASE_PATH)` connection to seed or assert past the
  // API — a second, independent connection to the same file, live at the
  // same time as the API's. Confirmed by reproducing it (`docs/DECISIONS.md`):
  // baseline runs failed 3 of 5 with `apps/api`'s own log recording both
  // `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT` from inside `courses.ts` and
  // `course-join-links.ts` transactions. Raising `busy_timeout` cannot fix
  // the latter — a snapshot invalidated by a concurrent commit is not a lock
  // to wait out, it is a transaction that must restart — so the fix is to
  // remove the concurrent connection, not to make it wait longer. `workers:
  // 1` costs real wall clock (~11-12s became ~20-26s across ten runs
  // locally) in exchange for a suite that gives the same answer every time;
  // a database per spec file (per worker) was rejected as materially more
  // machinery for a suite this size — see docs/DECISIONS.md's D-62 for the
  // full trade. `globalSetup` below fails loudly if this is ever raised back
  // without knowing why.
  workers: 1,
  globalSetup: './e2e/support/require-single-worker.ts',
  // No retries in this slice: a flake here should be diagnosed, not hidden
  // by Playwright's own retry loop re-running a real API and database.
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: E2E_PUBLIC_APP_URL,
  },
  webServer: [
    {
      command: 'npx tsx e2e/support/start-api.ts',
      url: `${E2E_API_ORIGIN}/health`,
      // `apps/api`'s `GET /health` (API-6) answers `503` until its
      // database is reachable — Playwright polls the URL until it gets any
      // response at all, so a `503` still counts as "up" here; the spec
      // itself is what actually exercises the API, not this readiness
      // check.
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        PUBLIC_APP_URL: E2E_PUBLIC_APP_URL,
        // ADMIN-4/AUTH-4 — a fixed platform-administrator address this
        // spec's own `admin-console.spec.ts` signs in as through the
        // ordinary emailed-link flow, then reads live from this env var on
        // every check (`@bloombot/config`'s `isAdminEmail`) — never a
        // database flag.
        ADMIN_EMAILS: E2E_ADMIN_EMAIL,
      },
    },
    {
      // `--host 127.0.0.1` explicitly: without it, `vite preview`'s default
      // host binding was observed not to answer on `127.0.0.1` promptly
      // enough for Playwright's own readiness poll below, which checks
      // exactly that address.
      command: `npx vite preview --port ${E2E_WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: './apps/web',
      url: E2E_PUBLIC_APP_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        // Read by apps/web/vite.config.ts to build the same-origin proxy
        // (`/auth`, `/organizations`, `/health`) this app relies on in
        // production (nginx) — WEB-1.
        API_PORT: String(E2E_API_PORT),
      },
    },
  ],
})
