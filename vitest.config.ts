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
      '@bloombot/legacy-import': sourceEntry('legacy-import'),
      '@bloombot/core': sourceEntry('core'),
    },
  },
  test: {
    // QA-4: the coverage floor sits over the logic that matters — the
    // data-access layer and the answering pipeline (`.claude/CLAUDE.md`) —
    // not a blanket percentage across the tree — a package like `db` has
    // plenty of code (schema definitions, the migration runner) that is
    // exercised end-to-end by every other test rather than meaningfully
    // unit-testable on its own.
    coverage: {
      provider: 'v8',
      include: ['packages/db/src/repos/**/*.ts', 'packages/core/src/**/*.ts'],
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
    ],
  },
})
