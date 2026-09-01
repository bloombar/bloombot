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
 */
const BUNDLED_PACKAGE_SIGNATURES = [
  'better-sqlite3',
  'discord_server_bindings',
  'pino',
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
    execFileSync('npx', ['vite', 'build'], { cwd: APP_ROOT, stdio: 'pipe' })
  }, 60_000)

  it('produces a dist/ directory with at least one JS bundle', () => {
    expect(statSync(DIST_DIR).isDirectory()).toBe(true)
    const jsFiles = listFilesRecursively(DIST_DIR).filter((file) =>
      file.endsWith('.js')
    )
    expect(jsFiles.length).toBeGreaterThan(0)
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
