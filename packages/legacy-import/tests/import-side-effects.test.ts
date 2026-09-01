/**
 * PLAT-5: importing any module in this package must not open a connection,
 * create a file or a directory, read the legacy snapshot, or throw — even
 * when `DATABASE_PATH` points somewhere that has never existed. The same
 * check `packages/db/tests/import-side-effects.test.ts` runs for that
 * package, applied here.
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetConfigCache } from '@bloombot/config'

// Every module this package ships, relative to this test file — listed by
// hand rather than walked with `readdirSync`, the same trade-off
// `packages/db`'s equivalent test makes.
const MODULES = [
  '../src/guard.ts',
  '../src/ids.ts',
  '../src/read-legacy.ts',
  '../src/import-config.ts',
  '../src/import-people.ts',
  '../src/import-messages.ts',
  '../src/import.ts',
  '../src/cli.ts',
  '../src/index.ts',
]

const BOGUS_ROOT = join(process.cwd(), 'tmp', 'legacy-import-side-effects')
const BOGUS_DATABASE_PATH = join(BOGUS_ROOT, 'should-never-be-created.db')

beforeEach(() => {
  resetConfigCache()
  process.env.NODE_ENV = 'test'
  process.env.PUBLIC_APP_URL = 'https://bloombot.example.edu'
  process.env.DATABASE_PATH = BOGUS_DATABASE_PATH
})

afterEach(() => {
  resetConfigCache()
  delete process.env.DATABASE_PATH
  delete process.env.PUBLIC_APP_URL
  rmSync(BOGUS_ROOT, { recursive: true, force: true })
})

describe('import-time side effects (PLAT-5)', () => {
  it.each(MODULES)(
    'importing %s creates no file and throws nothing',
    async (path) => {
      await expect(import(path)).resolves.toBeDefined()

      expect(existsSync(BOGUS_DATABASE_PATH)).toBe(false)
      expect(existsSync(BOGUS_ROOT)).toBe(false)
    }
  )
})
