import { describe, expect, it } from 'vitest'

import { assertMigratablePath } from '../src/run-migrate.js'

describe('assertMigratablePath', () => {
  it('refuses a relative path under data/ without --i-know', () => {
    expect(() => assertMigratablePath('./data/data.db', [])).toThrow(/--i-know/)
    expect(() => assertMigratablePath('data/data.db', [])).toThrow(/--i-know/)
  })

  it('refuses an absolute path with a data/ segment without --i-know', () => {
    expect(() =>
      assertMigratablePath('/srv/bloombot/data/data.db', [])
    ).toThrow(/--i-know/)
  })

  it('allows a path under data/ when --i-know is passed', () => {
    expect(() =>
      assertMigratablePath('./data/data.db', ['--i-know'])
    ).not.toThrow()
  })

  it('allows a path outside data/ without any flag', () => {
    expect(() => assertMigratablePath('./tmp/test.db', [])).not.toThrow()
  })
})
