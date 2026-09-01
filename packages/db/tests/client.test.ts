import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase } from '@bloombot/db'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('openDatabase', () => {
  it('creates the file and its parent directory on open', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-client-'))
    const path = join(dir, 'nested', 'test.db')

    const db = openDatabase(path)
    try {
      expect(existsSync(path)).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('sets WAL journal mode, the busy timeout and foreign_keys on (D-2)', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-client-'))
    const db = openDatabase(join(dir, 'test.db'))
    try {
      expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(5000)
      expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally {
      closeDatabase(db)
    }
  })

  it('opens an in-memory database without touching the filesystem', () => {
    const db = openDatabase(':memory:')
    try {
      expect(db.$client.pragma('journal_mode', { simple: true })).toBeDefined()
    } finally {
      closeDatabase(db)
    }
  })
})

describe('closeDatabase', () => {
  it('releases the file handle so a later query fails rather than hangs', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-client-'))
    const db = openDatabase(join(dir, 'test.db'))

    closeDatabase(db)

    expect(() => db.$client.pragma('journal_mode')).toThrow()
  })
})
