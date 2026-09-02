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

/**
 * CONV-4/D-49 — the condition this pair of `openDatabase` connections
 * reproduces here for real, against the exact pragmas `openDatabase` itself
 * sets, is what `repos/conversations.ts#appendMessage`'s own doc comment
 * describes: a deferred transaction (Drizzle's own default, before this
 * slice) takes its read snapshot at its *first* statement, not at `BEGIN` —
 * so a second connection that commits a write in between leaves the first
 * unable to upgrade that snapshot to a write lock. Reproduced with two real
 * connections to one file, no mock: no `Atomics.wait`/worker thread is
 * needed, because every call below is itself synchronous and non-blocking
 * — `connB`'s write below never has to wait for `connA`, so ordinary
 * sequential JS statements are enough to force the exact interleaving that
 * produces it, deterministically, every run.
 */
describe('SQLITE_BUSY_SNAPSHOT (CONV-4/D-49): what busy_timeout does not cover', () => {
  it('a deferred transaction that reads before another connection commits cannot upgrade to write, and busy_timeout does not wait it out', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-client-'))
    const path = join(dir, 'test.db')

    const connA = openDatabase(path)
    const connB = openDatabase(path)
    try {
      connA.$client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      connA.$client.exec("INSERT INTO t (v) VALUES ('seed')")

      // `connA` opens deferred (SQLite's own default for a bare `BEGIN`) and
      // reads — this is the statement that establishes its read snapshot,
      // the same moment `appendMessage`'s own pre-fix `select` did.
      connA.$client.exec('BEGIN DEFERRED')
      connA.$client.prepare('SELECT * FROM t').get()

      // `connB` — a stand-in for one of the other three processes sharing
      // this file (`ecosystem.config.cjs`) — commits a write in between,
      // advancing the database past the snapshot `connA` already took.
      connB.$client.exec('BEGIN IMMEDIATE')
      connB.$client.prepare('INSERT INTO t (v) VALUES (?)').run('from B')
      connB.$client.exec('COMMIT')

      // `connA` now tries to write against a snapshot that is already
      // stale. This is not a lock wait — nothing is *held* for
      // `busy_timeout` to wait out — so it fails immediately, not after the
      // 5s `openDatabase` itself configures (D-2's own busy_timeout pragma,
      // asserted above in this same file).
      const start = Date.now()
      let caught: unknown
      try {
        connA.$client.prepare('INSERT INTO t (v) VALUES (?)').run('from A')
      } catch (error) {
        caught = error
      }
      const elapsedMs = Date.now() - start

      expect(caught).toMatchObject({ code: 'SQLITE_BUSY_SNAPSHOT' })
      // Nowhere near the 5,000ms `busy_timeout` — proves this was reported
      // immediately, not waited out and then given up on.
      expect(elapsedMs).toBeLessThan(1000)

      connA.$client.exec('ROLLBACK')
    } finally {
      closeDatabase(connA)
      closeDatabase(connB)
    }
  })

  it('the same interleaving against an immediate transaction blocks behind busy_timeout instead — an ordinary, already-covered wait', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-client-'))
    const path = join(dir, 'test.db')

    const connA = openDatabase(path)
    const connB = openDatabase(path)
    try {
      connA.$client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      connA.$client.exec("INSERT INTO t (v) VALUES ('seed')")
      // A short timeout so this test does not itself wait 5s to prove the
      // point — the mechanism is the same regardless of the number.
      connB.$client.pragma('busy_timeout = 200')

      // `connA` opens `immediate` (the fix, matching `appendMessage`'s own
      // `{ behavior: 'immediate' }`) and holds the write lock for the rest
      // of this test — reads happen *after* the lock, so there is no
      // snapshot left to go stale.
      connA.$client.exec('BEGIN IMMEDIATE')
      connA.$client.prepare('SELECT * FROM t').get()

      // `connB` now has to wait for `connA`'s lock rather than racing a
      // snapshot — an ordinary contended write, exactly what `busy_timeout`
      // exists to cover, so it is `SQLITE_BUSY` (a lock that is *held*),
      // never `SQLITE_BUSY_SNAPSHOT`.
      const start = Date.now()
      let caught: unknown
      try {
        connB.$client.exec('BEGIN IMMEDIATE')
      } catch (error) {
        caught = error
      }
      const elapsedMs = Date.now() - start

      expect(caught).toMatchObject({ code: 'SQLITE_BUSY' })
      // The symmetric assertion to the previous test's own `toBeLessThan`:
      // without this, a `BEGIN IMMEDIATE` that failed *instantly*, without
      // ever consulting `busy_timeout` at all, would pass identically —
      // and would falsify the fix's own premise, that this case is an
      // ordinary, already-covered lock wait rather than another
      // uncoverable immediate failure. `connB`'s own `busy_timeout = 200`
      // above is what this proves was actually spent.
      expect(elapsedMs).toBeGreaterThanOrEqual(200)

      connA.$client.exec('ROLLBACK')
    } finally {
      closeDatabase(connA)
      closeDatabase(connB)
    }
  })
})
