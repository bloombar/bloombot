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
    },
  },
  test: {
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
    ],
  },
})
