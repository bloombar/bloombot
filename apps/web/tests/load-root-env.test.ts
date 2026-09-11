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
})
