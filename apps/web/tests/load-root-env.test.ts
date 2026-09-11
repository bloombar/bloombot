/**
 * WEB-47 defect: `resolveRootEnvFallback` (`../load-root-env.js`) — the
 * pure resolution logic behind `vite.config.ts`'s root-`.env` fallback.
 * Exercised against throwaway directories under `tmp/`, never against the
 * developer's own `apps/web/.env` or repository-root `.env`
 * (`apps/web/tests/mcp.test.tsx`'s own rule, established by WEB-47 defect
 * #409: "the MCP tests must not read the developer's own .env" — the same
 * hazard applies here, since this helper's whole job is reading `.env`
 * files by directory).
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveRootEnvFallback } from '../load-root-env.js'

const TMP_ROOT = join(process.cwd(), 'tmp', 'web-tests', 'load-root-env')

const REAL_ENV_KEY = 'VITE_MCP_PUBLIC_URL'

let caseDir: string
let webDir: string
let rootDir: string
let realEnvValue: string | undefined

beforeEach(() => {
  caseDir = join(TMP_ROOT, randomUUID())
  webDir = join(caseDir, 'apps-web')
  rootDir = join(caseDir, 'root')
  mkdirSync(webDir, { recursive: true })
  mkdirSync(rootDir, { recursive: true })

  // The same hazard `mcp.test.tsx` already guards against for
  // `import.meta.env`: Vite's real `loadEnv` (called for real here, not
  // mocked) always overlays whatever `VITE_MCP_PUBLIC_URL` is already in
  // the *actual* `process.env` on top of a directory's own files
  // (`node.js#loadEnv`'s own "process.env always wins" pass) — and on a
  // machine running the real deployment, Vitest's own Vite-based config
  // resolution has already loaded the developer's real repository-root
  // `.env` into `process.env` before this test ever runs. Clearing the key
  // here makes every case below about the throwaway `webDir`/`rootDir`
  // files it writes, not an accident of which machine ran it.
  realEnvValue = process.env[REAL_ENV_KEY]
  delete process.env[REAL_ENV_KEY]
})

afterEach(() => {
  rmSync(caseDir, { recursive: true, force: true })
  if (realEnvValue === undefined) delete process.env[REAL_ENV_KEY]
  else process.env[REAL_ENV_KEY] = realEnvValue
})

describe('resolveRootEnvFallback (WEB-47 defect)', () => {
  it('falls back to a VITE_ key set only in the root .env', () => {
    writeFileSync(
      join(rootDir, '.env'),
      'VITE_MCP_PUBLIC_URL=https://bloombot.wonkledge.com/mcp\n'
    )

    const fallback = resolveRootEnvFallback('production', webDir, rootDir, {})

    expect(fallback['VITE_MCP_PUBLIC_URL']).toBe(
      'https://bloombot.wonkledge.com/mcp'
    )
  })

  it('lets a local apps/web .env value win over the same root key', () => {
    writeFileSync(
      join(rootDir, '.env'),
      'VITE_MCP_PUBLIC_URL=https://root-value.example/mcp\n'
    )
    writeFileSync(
      join(webDir, '.env'),
      'VITE_MCP_PUBLIC_URL=https://local-value.example/mcp\n'
    )

    const fallback = resolveRootEnvFallback('production', webDir, rootDir, {})

    // The key is already satisfied locally, so it must not appear in what
    // gets injected — injecting it would overwrite the local value's
    // precedence once vite.config.ts assigns it onto process.env.
    expect(fallback['VITE_MCP_PUBLIC_URL']).toBeUndefined()
  })

  it('lets an existing process.env value win over the same root key', () => {
    writeFileSync(
      join(rootDir, '.env'),
      'VITE_MCP_PUBLIC_URL=https://root-value.example/mcp\n'
    )

    const fallback = resolveRootEnvFallback('production', webDir, rootDir, {
      VITE_MCP_PUBLIC_URL: 'https://inline-value.example/mcp',
    })

    expect(fallback['VITE_MCP_PUBLIC_URL']).toBeUndefined()
  })

  it('returns nothing when the root has no matching .env file', () => {
    const fallback = resolveRootEnvFallback('production', webDir, rootDir, {})

    expect(fallback).toEqual({})
  })

  it('uses process.env by default (the form vite.config.ts actually calls)', () => {
    // Every case above passes an explicit `currentEnv`, which never
    // exercises the `= process.env` default parameter — the only form
    // `vite.config.ts` itself uses, and the guard doing the real
    // "local/ambient wins over root" precedence work. `REAL_ENV_KEY` is
    // cleared in `beforeEach` above, so setting it here on the *real*
    // `process.env` (not a stand-in object) and confirming it suppresses
    // the same root value the earlier tests injected via an explicit
    // object proves the default parameter does the same job.
    process.env[REAL_ENV_KEY] = 'https://ambient-value.example/mcp'
    writeFileSync(
      join(rootDir, '.env'),
      'VITE_MCP_PUBLIC_URL=https://root-value.example/mcp\n'
    )

    const fallback = resolveRootEnvFallback('production', webDir, rootDir)

    expect(fallback[REAL_ENV_KEY]).toBeUndefined()
  })

  // WEB-47 rework (round 1) — reproduced defect: Vite's own `loadEnv`
  // (called for real here, not mocked) writes three *unprefixed* keys onto
  // `process.env` as a side effect whenever it finds them in a directory's
  // parsed env file, regardless of the `'VITE_'` prefix filter this module
  // passes it — `NODE_ENV` becomes `process.env.VITE_USER_NODE_ENV`,
  // `BROWSER` and `BROWSER_ARGS` are copied as-is. The repository root
  // `.env` ships `NODE_ENV=development` (`env.example`), so calling
  // `loadEnv` against the root leaked that in, undetectable by the
  // `'VITE_'`-prefix filter above — and, downstream, silently forced a
  // development Vite build regardless of the actual `NODE_ENV` (the module
  // comment on `load-root-env.ts` has the full chain). This test writes
  // `NODE_ENV`, `BROWSER` and `BROWSER_ARGS` into the root `.env` the same
  // way a real deployment's does, and asserts none of the three leaked.
  describe("does not leak loadEnv's unprefixed side effects onto process.env", () => {
    const SIDE_EFFECT_KEYS = ['VITE_USER_NODE_ENV', 'BROWSER', 'BROWSER_ARGS']
    let snapshot: Record<string, string | undefined>

    beforeEach(() => {
      snapshot = Object.fromEntries(
        SIDE_EFFECT_KEYS.map((key) => [key, process.env[key]])
      )
      for (const key of SIDE_EFFECT_KEYS) delete process.env[key]
    })

    afterEach(() => {
      for (const key of SIDE_EFFECT_KEYS) {
        const value = snapshot[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    it('leaves VITE_USER_NODE_ENV and BROWSER untouched when the root .env sets NODE_ENV and BROWSER', () => {
      writeFileSync(
        join(rootDir, '.env'),
        ['NODE_ENV=development', 'BROWSER=none', 'BROWSER_ARGS=--foo'].join(
          '\n'
        ) + '\n'
      )

      resolveRootEnvFallback('production', webDir, rootDir, {})

      expect(process.env['VITE_USER_NODE_ENV']).toBeUndefined()
      expect(process.env['BROWSER']).toBeUndefined()
      expect(process.env['BROWSER_ARGS']).toBeUndefined()
    })

    it('restores a pre-existing VITE_USER_NODE_ENV rather than deleting it', () => {
      process.env['VITE_USER_NODE_ENV'] = 'already-set'
      writeFileSync(join(rootDir, '.env'), 'NODE_ENV=development\n')

      resolveRootEnvFallback('production', webDir, rootDir, {})

      expect(process.env['VITE_USER_NODE_ENV']).toBe('already-set')
    })

    it('never returns VITE_USER_NODE_ENV in the fallback itself, not only in process.env', () => {
      // `VITE_USER_NODE_ENV` starts with `'VITE_'`, so — unlike `BROWSER`/
      // `BROWSER_ARGS` — it survives `loadEnv`'s own prefix filter and gets
      // copied into the record `loadEnv` hands back by its own final pass
      // (`node.js`: `for (const key in process.env) if (prefixes.some(...))
      // env[key] = process.env[key]`), which runs *before* this module's
      // `finally` block has a chance to restore `process.env`. Restoring
      // `process.env` alone is therefore not enough — the fallback record
      // itself has to be stripped, or `vite.config.ts` would assign the
      // leaked value onto `process.env` a second time, permanently, from
      // this function's own return value.
      writeFileSync(join(rootDir, '.env'), 'NODE_ENV=development\n')

      const fallback = resolveRootEnvFallback('production', webDir, rootDir, {})

      expect(fallback['VITE_USER_NODE_ENV']).toBeUndefined()
    })
  })

  it('skips reading the root entirely when BLOOMBOT_SKIP_ROOT_ENV_FALLBACK is set (test-determinism hatch)', () => {
    writeFileSync(
      join(rootDir, '.env'),
      'VITE_MCP_PUBLIC_URL=https://root-value.example/mcp\n'
    )

    const fallback = resolveRootEnvFallback('production', webDir, rootDir, {
      BLOOMBOT_SKIP_ROOT_ENV_FALLBACK: '1',
    })

    expect(fallback).toEqual({})
  })
})
