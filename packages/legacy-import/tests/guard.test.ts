/**
 * MIG-1: the importer refuses a snapshot path that resolves into this
 * repository's own `data/` directory, with no override — the test that
 * matters most in this slice.
 */

import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assertLegacySnapshotPath } from '../src/guard.js'

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
})
