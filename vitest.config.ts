// Root vitest configuration: one project per workspace package (PLAT-1).
//
// The aliases point cross-package imports at TypeScript source rather than at
// each package's built `dist`. Without them a test run would silently assert
// against whatever was last built, which is the kind of stale green that hides
// a real regression for a week.

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sourceEntry = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@bloombot/config': sourceEntry('config'),
      '@bloombot/logger': sourceEntry('logger'),
      '@bloombot/schemas': sourceEntry('schemas'),
      '@bloombot/db': sourceEntry('db'),
      '@bloombot/auth': sourceEntry('auth'),
      '@bloombot/mail': sourceEntry('mail'),
      '@bloombot/legacy-import': sourceEntry('legacy-import'),
      '@bloombot/core': sourceEntry('core'),
      '@bloombot/openai': sourceEntry('openai'),
      '@bloombot/discord': sourceEntry('discord'),
      '@bloombot/discord-rest': sourceEntry('discord-rest'),
      '@bloombot/actions': sourceEntry('actions'),
      '@bloombot/jobs': sourceEntry('jobs'),
    },
  },
  test: {
    // QA-4: the coverage floor sits over the logic that matters — the
    // data-access layer and the answering pipeline (`.claude/CLAUDE.md`) —
    // not a blanket percentage across the tree — a package like `db` has
    // plenty of code (schema definitions, the migration runner) that is
    // exercised end-to-end by every other test rather than meaningfully
    // unit-testable on its own. `packages/openai` joins the floor here
    // (MDL-1..7): it is the vendor adapter behind the model port, exactly
    // the kind of logic-that-matters this floor exists to hold.
    // `packages/discord` joins it too (SURF-1..7): it holds every line of
    // Discord surface logic actually testable without discord.js — binding
    // lookup, person resolution, routing, splitting, rendering. `apps/bot`
    // stays outside the floor: it is the thin, deliberately-untested wiring
    // to the gateway this slice's brief asks to keep "thin enough that its
    // untested part is obvious", not logic this floor exists to hold.
    // `packages/actions` joins it too (ACT-1..6): it is the single write
    // path every surface dispatches through, exactly the kind of
    // logic-that-matters this floor exists to hold. `packages/auth` joins it
    // too (AUTH-1..4): tokens, sessions and the identity-linking rule are
    // exactly the security-critical logic this floor exists to hold to a
    // standard, not the coverage of the platform as a whole. `apps/api`
    // (API-1..6) stays outside the floor, the same call already made for
    // `apps/bot` above and for the same reason: every rule it enforces —
    // authorization, tenant scoping, error mapping — is `packages/actions`'
    // or `packages/auth`'s own, already held to this floor there; what
    // lives in `apps/api` itself is wiring an Express app around those two
    // packages, tested thoroughly in `apps/api/tests` but not gated by a
    // percentage a thin translation layer would only game. `packages/discord-rest`
    // joins the floor too (cheap-fix 6 of the TEN-4..6 rework): it is the
    // vendor adapter behind the Discord install flow — `packages/openai`'s
    // own reasoning above applies unchanged, and it is the one adapter in
    // this list that handles both the OAuth client secret and a user's own
    // access token, not a lesser case for the floor than `packages/openai`.
    // `packages/mail` joins the floor too (AUTH-5, D-46): the SMTP adapter
    // behind `EmailSender` — `packages/openai`'s own "vendor adapter, so it
    // belongs on the floor" reasoning applies unchanged, and this one
    // specifically carries a bearer credential (a sign-in link) through
    // every code path, exactly the security-critical territory this floor
    // exists for.
    // `apps/web` (WEB-1..6, QA-7) stays outside the floor for the same
    // reason `apps/bot` and `apps/api` do: it is a thin translation layer —
    // here, HTTP calls and JSX markup around the rules `packages/actions`
    // and `packages/auth` already hold to this standard — and a coverage
    // percentage over markup buys assertions about DOM structure at the
    // cost of attention to logic (QA-4's own wording). Its tests
    // (`apps/web/tests`) still run as part of `npm test`, just not gated by
    // a number here. `packages/jobs` joins the floor too (JOB-1..4): the
    // claim/retry/admission logic every background job and the model
    // concurrency bound run through, exactly the kind of logic-that-matters
    // this floor exists to hold — `apps/worker` (JOB-5) stays outside it,
    // the same thin-process call already made for `apps/bot`/`apps/api`
    // above: claim, run, complete or fail, sleep, repeat around
    // `packages/jobs`'s own `runNextJob`, tested in `apps/worker/tests` but
    // not gated by a number here. `apps/mcp` (MCP-1..5) stays outside the
    // floor too, the same call already made for every other app in this
    // list: every rule it enforces — dispatch, refusals, tenancy — is
    // `packages/actions`'s own, already held to this floor there; what
    // lives in `apps/mcp` itself (`tool-surface.ts`'s allowlist,
    // `call-tool.ts`'s dispatch wiring, `server.ts`'s transport adapter) is
    // tested thoroughly in `apps/mcp/tests` but not gated by a percentage
    // here.
    // Timeouts sized for a loaded developer machine, not for an idle one.
    //
    // Vitest's 5s test and 10s hook defaults are comfortable when the suite
    // has the machine to itself, and far too tight when it does not. The
    // tests that fail first are the ones that spawn something — the PLAT-5
    // import-side-effect checks start a child Node process per module, and
    // `google.test.ts` starts a fake HTTPS server in a `beforeEach` — so a
    // busy machine produces a different random handful of failures each run.
    // That flakiness is worse than useless: it costs real time to re-run and
    // re-diagnose, and it teaches people to disbelieve a red suite.
    //
    // These are ceilings, not waits. A passing test still finishes in
    // milliseconds; only a genuinely stuck one takes the full budget, and a
    // real hang still fails rather than running forever. The `web` project
    // below already carries its own 60s for the same reason — a real
    // `vite build` — so this generalizes a call already made once.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/db/src/repos/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/openai/src/**/*.ts',
        'packages/discord/src/**/*.ts',
        'packages/actions/src/**/*.ts',
        'packages/auth/src/**/*.ts',
        'packages/discord-rest/src/**/*.ts',
        'packages/jobs/src/**/*.ts',
        'packages/mail/src/**/*.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'config',
          root: './packages/config',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'logger',
          root: './packages/logger',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'schemas',
          root: './packages/schemas',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          root: './packages/db',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'auth',
          root: './packages/auth',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'mail',
          root: './packages/mail',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'legacy-import',
          root: './packages/legacy-import',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'core',
          root: './packages/core',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'openai',
          root: './packages/openai',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'discord',
          root: './packages/discord',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'actions',
          root: './packages/actions',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'discord-rest',
          root: './packages/discord-rest',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'jobs',
          root: './packages/jobs',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'bot',
          root: './apps/bot',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'worker',
          root: './apps/worker',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'mcp',
          root: './apps/mcp',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          // WEB-1..6: the panel's own logic — the organization switcher,
          // WEB-5's error rendering, and the install button's outcomes
          // (`tests/*.test.tsx`) — plus the WEB-6 bundle test
          // (`tests/bundle.test.ts`), which runs a real `vite build` and is
          // slower than the rest of this project; nothing else in this repo
          // needs a browser-like environment, so `jsdom` is scoped to this
          // one project rather than the root config.
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['tests/**/*.test.{ts,tsx}'],
          setupFiles: ['./tests/setup.ts'],
          testTimeout: 60_000,
        },
      },
    ],
  },
})
