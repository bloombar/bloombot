/**
 * CFG-5: `.env` is where credentials live, and every entry point loads it.
 *
 * This exists because the bug it prevents actually happened: `.env` was
 * written, documented in `docs/RUNNING_LOCALLY.md`, and read by nothing, so
 * `npm run api:dev` on a correctly configured checkout failed at startup naming
 * variables that were sitting in the file the whole time.
 *
 * The fixtures deliberately do not use the name `.env` — a hook in this
 * repository blocks writes to `.env*`, because a real one holds live
 * credentials, and a test that had to be exempted from that guard would be a
 * test worth distrusting.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadDotEnv } from '../src/dotenv.js'

let scratch: string | undefined
const originals = new Map<string, string | undefined>()

const remember = (name: string): void => {
  if (!originals.has(name)) originals.set(name, process.env[name])
}

afterEach(() => {
  for (const [name, value] of originals) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  originals.clear()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const envFile = (contents: string): string => {
  scratch = mkdtempSync(join(tmpdir(), 'bloombot-dotenv-'))
  const path = join(scratch, 'environment-fixture')
  writeFileSync(path, contents, 'utf8')
  return path
}

describe('loadDotEnv', () => {
  it("puts a file's values into the environment", () => {
    remember('BLOOMBOT_DOTENV_FIXTURE')
    delete process.env['BLOOMBOT_DOTENV_FIXTURE']

    const result = loadDotEnv(envFile('BLOOMBOT_DOTENV_FIXTURE=from_file\n'))

    expect(result.loaded).toBe(true)
    expect(process.env['BLOOMBOT_DOTENV_FIXTURE']).toBe('from_file')
  })

  it('leaves a variable that is already set — a real environment beats the file', () => {
    // The property that makes this safe in production: a deployment that sets
    // its own environment is never overridden by a file that happens to exist,
    // and a test runner's NODE_ENV survives.
    remember('BLOOMBOT_DOTENV_FIXTURE')
    process.env['BLOOMBOT_DOTENV_FIXTURE'] = 'from_environment'

    loadDotEnv(envFile('BLOOMBOT_DOTENV_FIXTURE=from_file\n'))

    expect(process.env['BLOOMBOT_DOTENV_FIXTURE']).toBe('from_environment')
  })

  it('does nothing when the file is absent, because production has no .env', () => {
    scratch = mkdtempSync(join(tmpdir(), 'bloombot-dotenv-'))
    const missing = join(scratch, 'not-written')

    const result = loadDotEnv(missing)

    expect(result).toEqual({ loaded: false, path: missing })
  })
})
