/**
 * MIG-1: the importer refuses a snapshot path that resolves into this
 * repository's own `data/` directory, with no override — the test that
 * matters most in this slice. Alongside it, `assertImportDestinationPath`
 * (finding 1): the importer also refuses to open its *destination*, the
 * platform database, when it resolves into `data/` — unless `--i-know` is
 * passed.
 */

import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertImportDestinationPath,
  assertLegacySnapshotPath,
} from '../src/guard.js'

const TMP_ROOT = join(process.cwd(), 'tmp', 'legacy-import-guard-tests')

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe('assertLegacySnapshotPath', () => {
  it('refuses a relative path under data/', () => {
    expect(() => assertLegacySnapshotPath('./data/data.db')).toThrow(
      /live student database/
    )
    expect(() => assertLegacySnapshotPath('data/data.db')).toThrow(
      /live student database/
    )
  })

  it('has no override — refuses data/ even with an --i-know-shaped argument ignored', () => {
    // There is no `--i-know` escape hatch for this guard (unlike
    // `db:migrate`'s `assertMigratablePath`): the function does not even
    // accept a flag to bypass it.
    expect(() => assertLegacySnapshotPath('./data/data.db')).toThrow()
  })

  // resolve() alone does not follow symlinks — a symlink that lives entirely
  // outside data/ but points *at* something inside it must still trip the
  // guard.
  it('refuses a symlink that resolves into data/', () => {
    mkdirSync(TMP_ROOT, { recursive: true })
    const link = join(TMP_ROOT, 'looks-harmless.db')
    // Points at an existing, non-database file under data/ — proving the
    // path-resolution guard without ever reading or writing data/data.db.
    symlinkSync(resolve('data', 'readme.txt'), link)

    expect(() => assertLegacySnapshotPath(link)).toThrow(
      /live student database/
    )
  })

  it('accepts a tmp/ snapshot path', () => {
    const path = join(TMP_ROOT, 'snapshot.db')
    expect(() => assertLegacySnapshotPath(path)).not.toThrow()
  })

  // A path merely nested under some *other* directory that happens to be
  // named `data` must not trip the guard.
  it('accepts a tmp/ path under an unrelated directory named data', () => {
    const path = join(TMP_ROOT, 'data', 'tmp', 'snapshot.db')
    expect(() => assertLegacySnapshotPath(path)).not.toThrow()
  })

  // finding 2: darwin (this platform, development and CI) is
  // case-insensitive — `DATA/readme.txt` and `data/readme.txt` are the same
  // file on disk, and a guard built on plain `realpathSync` (which follows
  // symlinks but does not canonicalize case) let the upper-case spelling
  // sail past it. `resolveReal` now uses `realpathSync.native`.
  it('refuses a case-variant path that resolves into data/', () => {
    expect(() => assertLegacySnapshotPath('DATA/readme.txt')).toThrow(
      /live student database/
    )
  })
})

describe('assertImportDestinationPath', () => {
  it('refuses a relative path under data/ without --i-know', () => {
    expect(() => assertImportDestinationPath('./data/data.db', [])).toThrow(
      /--i-know/
    )
    expect(() => assertImportDestinationPath('data/data.db', [])).toThrow(
      /--i-know/
    )
  })

  it('allows a path under data/ when --i-know is passed', () => {
    expect(() =>
      assertImportDestinationPath('./data/data.db', ['--i-know'])
    ).not.toThrow()
  })

  // resolve() alone does not follow symlinks — a symlink that lives entirely
  // outside data/ but points *at* something inside it must still trip the
  // guard.
  it('refuses a symlink that resolves into data/ without --i-know', () => {
    mkdirSync(TMP_ROOT, { recursive: true })
    const link = join(TMP_ROOT, 'looks-harmless.db')
    symlinkSync(resolve('data', 'readme.txt'), link)

    expect(() => assertImportDestinationPath(link, [])).toThrow(/--i-know/)
  })

  // finding 2, this guard's second caller: the case-insensitive-volume gap
  // must be closed here too, not just for the snapshot guard.
  it('refuses a case-variant path that resolves into data/ without --i-know', () => {
    expect(() => assertImportDestinationPath('DATA/data.db', [])).toThrow(
      /--i-know/
    )
  })

  it('allows a tmp/ path under an unrelated directory named data', () => {
    const path = join(TMP_ROOT, 'data', 'tmp', 'test.db')
    expect(() => assertImportDestinationPath(path, [])).not.toThrow()
  })

  it('allows a plain tmp/ path without any flag', () => {
    expect(() => assertImportDestinationPath('./tmp/test.db', [])).not.toThrow()
  })
})
