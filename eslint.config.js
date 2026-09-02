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
  // @bloombot/auth depends on @bloombot/db and @bloombot/config (session and
  // sign-in-token hashes, the admin allowlist), so it carries the same
  // credential-surface risk transitively — reachable through this one import
  // rather than the two direct ones the rule already blocks.
  '@bloombot/auth',
  // @bloombot/discord-rest holds the Discord OAuth exchange
  // (exchangeAuthorizationCode spends BOT_TOKEN/DISCORD_CLIENT_SECRET) — the
  // one function whose entire job is spending a client secret. Named
  // explicitly rather than left to fall out of @bloombot/db/@bloombot/auth
  // above: it depends only on @bloombot/config, so nothing else in this list
  // would have caught it.
  '@bloombot/discord-rest',
  // @bloombot/openai holds the OpenAI Responses API adapter (OPENAI_API_KEY)
  // — the model package WEB-6 names by name, same reasoning as
  // @bloombot/discord-rest above.
  '@bloombot/openai',
  // @bloombot/jobs depends on @bloombot/db (the job queue's own repo) and
  // @bloombot/logger — the same transitive credential-surface reasoning
  // @bloombot/auth is named for above. Nothing in apps/web needs a
  // background-job queue or the model-call admission gate it also carries
  // (JOB-4); named explicitly so the boundary is enforced before a future
  // import needs it, not reviewed after one lands.
  '@bloombot/jobs',
  // @bloombot/mail holds the SMTP adapter (AUTH-5) — a sign-in link's own
  // relay credentials (MAIL_SMTP_USER/MAIL_SMTP_PASSWORD) flow through it,
  // the same "the vendor adapter, named by name" reasoning
  // @bloombot/discord-rest and @bloombot/openai already take above. Nothing
  // in apps/web needs to send mail.
  '@bloombot/mail',
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

  // PLAT-2 — `packages/schemas` depends on nothing but zod, enforced rather
  // than reviewed.
  //
  // The rule above stops `apps/web` importing another workspace package
  // directly, but `apps/web` is allowed to import `@bloombot/schemas` itself
  // (PLAT-2 names it the one exception). Without this rule, `schemas` could
  // import `@bloombot/config` — which holds `BOT_TOKEN` and `OPENAI_API_KEY`
  // — and the credential would still reach the browser bundle, just one hop
  // removed from the import the first rule was written to catch. Reuses
  // BROWSER_FORBIDDEN_PACKAGES rather than banning every `@bloombot/*`
  // import: `packages/schemas/tests` legitimately imports `@bloombot/schemas`
  // itself, through the workspace alias, to exercise its own public API —
  // that is a self-import, not a dependency on another package, and a
  // wildcard rule would have blocked it along with everything else. Applied
  // to both `src` and `tests`: a test that needed a *different* workspace
  // package would itself be evidence the boundary is wrong, not a reason to
  // exempt tests from checking it.
  {
    files: ['packages/schemas/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: BROWSER_FORBIDDEN_PACKAGES.map((name) => ({
            name,
            message:
              'packages/schemas depends on nothing but zod (PLAT-2). It must not import another workspace package.',
          })),
          patterns: [
            {
              group: BROWSER_FORBIDDEN_PACKAGES.map((name) => `${name}/*`),
              message:
                'packages/schemas depends on nothing but zod (PLAT-2). It must not import another workspace package.',
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
