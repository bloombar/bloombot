import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assertMigratablePath } from '../src/run-migrate.js'

const TMP_ROOT = join(process.cwd(), 'tmp', 'run-migrate-tests')

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe('assertMigratablePath', () => {
  it('refuses a relative path under data/ without --i-know', () => {
    expect(() => assertMigratablePath('./data/data.db', [])).toThrow(/--i-know/)
    expect(() => assertMigratablePath('data/data.db', [])).toThrow(/--i-know/)
  })

  it('allows a path under data/ when --i-know is passed', () => {
    expect(() =>
      assertMigratablePath('./data/data.db', ['--i-know'])
    ).not.toThrow()
  })

  // resolve() alone does not follow symlinks — a symlink that lives entirely
  // outside data/ but points *at* something inside it must still trip the
  // guard, the same way `DATABASE_PATH=/srv/app/live.db` symlinked at
  // `/srv/app/data/data.db` would sail past a guard that only textually
  // resolves `..` segments.
  it('refuses a symlink that resolves into data/ without --i-know', () => {
    mkdirSync(TMP_ROOT, { recursive: true })
    const link = join(TMP_ROOT, 'looks-harmless.db')
    // Points at an existing, non-database file under data/ — proving the
    // path-resolution guard without ever reading or writing data/data.db.
    symlinkSync(resolve('data', 'readme.txt'), link)

    expect(() => assertMigratablePath(link, [])).toThrow(/--i-know/)
  })

  // A path merely nested under some *other* directory that happens to be
  // named `data` — e.g. a droplet deployed under `/srv/data/bloombot` — must
  // not trip the guard. Only this repository's own data/ does; matching a
  // bare `data` path segment anywhere was the bug (finding 7).
  it('allows a tmp/ path under an unrelated directory named data', () => {
    const path = join(TMP_ROOT, 'data', 'tmp', 'test.db')

    expect(() => assertMigratablePath(path, [])).not.toThrow()
  })

  it('allows a plain tmp/ path without any flag', () => {
    expect(() => assertMigratablePath('./tmp/test.db', [])).not.toThrow()
  })

  // finding 2 (of the MIG-1 rework): darwin (this platform, development and
  // CI) is case-insensitive — `DATA/data.db` and `data/data.db` are the same
  // file on disk, and a guard built on plain `realpathSync` (which follows
  // symlinks but does not canonicalize case) let the upper-case spelling
  // sail past it, so `db:migrate DATA/data.db` wrote to the live file
  // without tripping the guard. `resolveReal` (`path-guard.ts`) now uses
  // `realpathSync.native`, which asks the OS for the real on-disk casing.
  it('refuses a case-variant path that resolves into data/ without --i-know', () => {
    expect(() => assertMigratablePath('DATA/data.db', [])).toThrow(/--i-know/)
  })
})
