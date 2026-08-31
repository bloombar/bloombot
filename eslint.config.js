// Flat ESLint config for the whole monorepo.
//
// The rule that matters most here is the PLAT-2 package boundary near the bottom.
// Everything else is the usual recommended set.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Workspace packages that must never reach a browser bundle. Each one either
// holds a secret itself or reaches something that does; importing any of them
// from `apps/web` would ship credentials to every visitor. See PLAT-2.
const BROWSER_FORBIDDEN_PACKAGES = [
  '@bloombot/db',
  '@bloombot/config',
  '@bloombot/logger',
]

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.tsbuild/**',
      'coverage/**',
      // Agent tooling and generated docs are owned elsewhere; linting them here
      // would turn unrelated edits into review noise.
      '.claude/**',
      'docs/**',
      // The Python bot this platform replaces.
      '**/__pycache__/**',
      '.pytest_cache/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Everything in this repo runs on Node, in ESM.
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // Board tooling is plain JavaScript; the TypeScript rules do not apply to it.
  {
    files: ['scripts/**/*.mjs', '*.config.js', '*.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  // PLAT-2 — package boundary, enforced rather than reviewed.
  //
  // `apps/web` does not exist yet. The rule is written now on purpose: its whole
  // value is being in place *before* somebody can add the import that leaks a
  // token into a browser bundle, at which point a lint error is cheap and a
  // rotated credential is not.
  {
    files: ['apps/web/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: BROWSER_FORBIDDEN_PACKAGES.map((name) => ({
            name,
            message:
              'apps/web is a browser bundle. It may import @bloombot/schemas and nothing else from the workspace (PLAT-2).',
          })),
          patterns: [
            {
              group: BROWSER_FORBIDDEN_PACKAGES.map((name) => `${name}/*`),
              message:
                'apps/web is a browser bundle. It may import @bloombot/schemas and nothing else from the workspace (PLAT-2).',
            },
          ],
        },
      ],
    },
  },

  // Tests may reach for `any` when building deliberately malformed fixtures.
  {
    files: ['packages/*/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
)
