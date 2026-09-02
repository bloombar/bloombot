/**
 * WEB-6: the browser bundle imports only `@bloombot/schemas` from the
 * workspace, and carries no server code and no credential. `eslint.config.js`'s
 * own `no-restricted-imports` rule (PLAT-2) already blocks the import at
 * source; this test is what makes that rule load-bearing rather than
 * advisory — it runs a real `vite build` and inspects the actual output, so
 * a forbidden import that somehow reached this app (a disabled lint rule, a
 * dynamic import the static rule cannot see) would still be caught here.
 *
 * `FORBIDDEN_PACKAGES` is the same list `eslint.config.js`'s own
 * `BROWSER_FORBIDDEN_PACKAGES` names — kept in sync by hand rather than
 * imported from that file (a `.js` ESLint flat config, not something this
 * package's own module graph reaches into), the same "not negotiable" list
 * that file's own comment describes.
 *
 * @vitest-environment node
 *
 * This file needs no DOM (it shells out to `vite build` and reads files) —
 * `vitest.config.ts`'s `web` project defaults to `jsdom`, where
 * `import.meta.url` is not a `file:` URL, so this file overrides back to
 * `node` rather than working around that.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(APP_ROOT, 'dist')

const FORBIDDEN_PACKAGES = [
  '@bloombot/db',
  '@bloombot/config',
  '@bloombot/logger',
  '@bloombot/auth',
  '@bloombot/discord-rest',
  '@bloombot/openai',
  '@bloombot/mail',
]

/**
 * Rollup/esbuild bundle a workspace package's *source* in, rather than
 * leaving its specifier as a string to require at runtime — so the literal
 * text `"@bloombot/db"` does not actually survive being bundled (proven
 * while writing this test: importing `@bloombot/db` from this app built
 * clean on the check above, because the specifier itself disappears once
 * Rollup inlines the module). What does survive is runtime-significant
 * string content *inside* that source — a SQL table name, a package the
 * workspace package itself depends on and requires by name — so this list
 * checks for those instead: `better-sqlite3` and `discord_server_bindings`
 * are `@bloombot/db`'s own (its native driver, and a table name literal in
 * `packages/db/src/schema.ts`), `pino` is `@bloombot/logger`'s. Nothing
 * distinct is needed for `@bloombot/config` or `@bloombot/auth` here:
 * `@bloombot/auth` depends on `@bloombot/db` (`eslint.config.js`'s own
 * comment on why it is in `BROWSER_FORBIDDEN_PACKAGES` at all), so
 * importing it would already trip the `@bloombot/db` signatures above.
 *
 * `discord.com/api` is `@bloombot/discord-rest`'s own signature — not a
 * string literal in that package's own files, but in `@bloombot/config`'s
 * `DISCORD_API_BASE`/`DISCORD_OAUTH_BASE` defaults, which `client.ts` and
 * `authorize-url.ts` both read at call time (`CONFIG.DISCORD_OAUTH_BASE`);
 * `@bloombot/discord-rest` depends on nothing else this app cannot already
 * reach some other way, so this is the one signature reachable only through
 * it (reproduced while writing this test: the earlier three signatures
 * above all miss it — finding 1 of the WEB-6 rework). `gpt-4o` is
 * `@bloombot/openai`'s own — `responses.ts`'s `DEFAULT_MODEL`, read by
 * `client.ts#ask` — caught today only by luck through the `better-sqlite3`/
 * `pino` signatures above (`@bloombot/openai` depends on `@bloombot/core`,
 * which depends on `@bloombot/db`), so it gets a signature of its own
 * rather than relying on a transitive edge that a future refactor of
 * `@bloombot/core` could remove.
 */
const BUNDLED_PACKAGE_SIGNATURES = [
  'better-sqlite3',
  'discord_server_bindings',
  'pino',
  'discord.com/api',
  'gpt-4o',
]

// Credential-shaped strings: the actual environment-variable names
// (`env.example`) a secret would be read through if one leaked into this
// bundle — not the secret values themselves, which this repo never has a
// real one of to check against in a test (QA-2, QA-3).
const CREDENTIAL_NAMES = [
  'BOT_TOKEN',
  'OPENAI_API_KEY',
  'DISCORD_CLIENT_SECRET',
  'BOT_PUBLIC_KEY',
]

/** Every file under `dir`, recursively — `dist/` is small (a handful of bundled chunks), so no need for a streaming walk. */
function listFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return listFilesRecursively(full)
    return [full]
  })
}

describe('apps/web bundle (WEB-6)', () => {
  beforeAll(() => {
    // A real production build (`vite build`, the same command
    // `apps/web/package.json#build` runs) — not a dev-server transform,
    // which does not bundle or minify and would not catch a forbidden
    // import the way the shipped artifact needs to be checked.
    //
    // `NODE_ENV: 'production'` is explicit rather than inherited: vitest
    // itself sets `NODE_ENV=test`, and `execFileSync` inherits the parent
    // process's environment by default, so without this override `vite
    // build` produced a *development* bundle — React's own dev build
    // inlined, ~400 kB, against ~199 kB from `npm run build` run directly —
    // even though this test's own comment already claimed to check "the
    // actual output" (cheap-fix 6 of the WEB-1..6 rework, reproduced by
    // running both and diffing `dist/`'s size). A superset bundle is
    // conservative for a "must not contain" check — nothing here was a
    // false negative — but the comment's claim was not true until this.
    execFileSync('npx', ['vite', 'build'], {
      cwd: APP_ROOT,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'production' },
    })
  }, 60_000)

  it('produces a dist/ directory with at least one JS bundle', () => {
    expect(statSync(DIST_DIR).isDirectory()).toBe(true)
    const jsFiles = listFilesRecursively(DIST_DIR).filter((file) =>
      file.endsWith('.js')
    )
    expect(jsFiles.length).toBeGreaterThan(0)
  })

  it('is a production build, not a development one (cheap-fix 6 of the WEB-1..6 rework)', () => {
    // "Download the React DevTools for a better development experience" is
    // react-dom's own development-only console message — present when
    // `NODE_ENV` is anything but `production` at build time, absent from a
    // real production build. A cheap, specific proxy for "this beforeAll
    // actually built what `npm run build` builds" that a byte-count
    // assertion would not survive a dependency upgrade to make.
    const files = listFilesRecursively(DIST_DIR).filter((file) =>
      file.endsWith('.js')
    )
    for (const file of files) {
      const contents = readFileSync(file, 'utf8')
      expect(
        contents.includes('React DevTools'),
        `${file} contains react-dom's development-only console message — this build was not built with NODE_ENV=production`
      ).toBe(false)
    }
  })

  it('contains none of the forbidden workspace packages, by specifier or by bundled signature', () => {
    const files = listFilesRecursively(DIST_DIR)
    for (const file of files) {
      const contents = readFileSync(file, 'utf8')
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(
          contents.includes(forbidden),
          `${file} contains "${forbidden}" — apps/web may import @bloombot/schemas and nothing else from the workspace (PLAT-2, WEB-6)`
        ).toBe(false)
      }
      for (const signature of BUNDLED_PACKAGE_SIGNATURES) {
        expect(
          contents.includes(signature),
          `${file} contains "${signature}" — a signature of a forbidden workspace package having been bundled in, not merely referenced by specifier (PLAT-2, WEB-6)`
        ).toBe(false)
      }
    }
  })

  it('contains no credential-shaped environment variable name', () => {
    const files = listFilesRecursively(DIST_DIR)
    for (const file of files) {
      const contents = readFileSync(file, 'utf8')
      for (const name of CREDENTIAL_NAMES) {
        expect(
          contents.includes(name),
          `${file} contains "${name}" — a credential must never reach the browser bundle (WEB-6)`
        ).toBe(false)
      }
    }
  })
})
