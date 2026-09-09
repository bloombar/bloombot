import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, writeTransaction } from '@bloombot/db'

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

/**
 * A small standalone script, run as a genuinely separate OS process (not a
 * nested call in this same one): it opens `path`, takes a real write lock
 * with `BEGIN IMMEDIATE`, writes a row, prints `LOCKED` (this test's cue that
 * the lock is actually held), holds it for `holdMs`, then commits and exits.
 *
 * A second connection *in this same process* cannot be used to hold the lock
 * open while the test's own connection attempts to write: better-sqlite3's
 * calls are synchronous, so whichever one is "holding" the lock would have
 * to still be on the call stack, blocking the only JS thread the attempt
 * also needs to run on — the two would deadlock rather than race. A real
 * second process has its own thread, so it can hold the lock across a real
 * wait while this test's own connection blocks on `busy_timeout` waiting for
 * it, exactly like a second one of `ecosystem.config.cjs`'s own five
 * processes would.
 */
const HOLD_WRITE_LOCK_SCRIPT = `
  const Database = require('better-sqlite3')
  const path = process.argv[1]
  const holdMs = Number(process.argv[2])
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec('BEGIN IMMEDIATE')
  db.prepare("INSERT INTO t (v) VALUES ('from-holder')").run()
  console.log('LOCKED')
  // A synchronous, non-busy-waiting sleep — this process must actually be
  // unresponsive to anything else for holdMs, the same as a real writer
  // mid-transaction, not polling in a way that could itself race the test.
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, holdMs)
  db.exec('COMMIT')
`

/**
 * Spawns `HOLD_WRITE_LOCK_SCRIPT` against `path`, and resolves once it has
 * confirmed the lock is held (its `LOCKED` line) — not merely once the
 * process has started, which race the test itself against the child's own
 * `BEGIN IMMEDIATE`.
 */
function holdWriteLockInChildProcess(
  path: string,
  holdMs: number
): Promise<{ waitForExit: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      HOLD_WRITE_LOCK_SCRIPT,
      path,
      String(holdMs),
    ])
    child.on('error', reject)
    child.stderr.on('data', (chunk: Buffer) => {
      // Surface a child crash as a test failure with the actual cause,
      // rather than a bare timeout with no explanation.
      reject(new Error(`holder process stderr: ${chunk.toString()}`))
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('LOCKED')) {
        resolve({
          waitForExit: () =>
            new Promise((exitResolve) => child.on('exit', () => exitResolve())),
        })
      }
    })
  })
}

/**
 * The race this slice fixes, reproduced against the exact CI failure
 * (`courses.ts#createCourse`, `database is locked`): two real connections to
 * one on-disk file, one genuinely holding a write transaction open (a
 * separate process, above — see its own comment for why this cannot be
 * simulated in-process), the other attempting a write transaction that reads
 * before it writes, `appendMessage`'s own shape and every other repo
 * function that opens its own transaction. Never against `data/data.db` —
 * `mkdtempSync(tmpdir())`, the same throwaway-under-`tmp/`-equivalent every
 * other test in this file already uses.
 */
describe('writeTransaction: a deferred-to-immediate lock upgrade is not the same wait as an ordinary one', () => {
  it('a plain db.transaction(...) — deferred, the pre-fix shape — throws immediately rather than waiting for a lock genuinely held elsewhere', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-client-'))
    const path = join(dir, 'test.db')

    const setup = openDatabase(path)
    setup.$client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    closeDatabase(setup)

    const holder = await holdWriteLockInChildProcess(path, 300)
    const db = openDatabase(path)
    try {
      const start = Date.now()
      let caught: unknown
      try {
        // Deferred (Drizzle's own default, unchanged by this slice's fix):
        // reads first, establishing a snapshot, before it ever asks for the
        // write lock the holder process already has.
        db.transaction((tx) => {
          tx.get('SELECT * FROM t')
          tx.run("INSERT INTO t (v) VALUES ('from-b')")
        })
      } catch (error) {
        caught = error
      }
      const elapsedMs = Date.now() - start

      expect(caught).toBeInstanceOf(Error)
      // Drizzle wraps the underlying `better-sqlite3` error in its own
      // `DrizzleError`, preserving the original as `.cause` — the same
      // place `isTransientBusyError` (`repos/conversations.ts`) does not
      // need to look, because it runs inside the retry loop closer to the
      // raw driver, but this assertion, outside `writeTransaction`
      // altogether, does.
      expect((caught as { cause?: { code?: string } }).cause?.code).toMatch(
        /^SQLITE_BUSY/
      )
      // The holder process holds the lock for 300ms; a deferred transaction
      // that actually honoured `busy_timeout` on this upgrade would wait
      // close to that before either succeeding or giving up. Failing this
      // much faster is what proves the pragma was never consulted at all.
      expect(elapsedMs).toBeLessThan(150)
    } finally {
      closeDatabase(db)
      await holder.waitForExit()
    }
  })

  it("writeTransaction(...) — BEGIN IMMEDIATE, this slice's fix — waits for the same genuinely held lock and succeeds", async () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-client-'))
    const path = join(dir, 'test.db')

    const setup = openDatabase(path)
    setup.$client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    closeDatabase(setup)

    const holdMs = 300
    const holder = await holdWriteLockInChildProcess(path, holdMs)
    const db = openDatabase(path)
    try {
      const start = Date.now()
      const rowCount = writeTransaction(db, (tx) => {
        // Reads first, exactly like the deferred test above and like every
        // repo function this slice touches — the fix is *when* the write
        // lock is taken (at `BEGIN`, not at this statement), not whether a
        // read happens first.
        tx.get('SELECT * FROM t')
        tx.run("INSERT INTO t (v) VALUES ('from-b')")
        return tx.get<{ n: number }>('SELECT count(*) AS n FROM t')
      })

      const elapsedMs = Date.now() - start

      // Both the holder's own insert and this one landed — nothing was
      // lost, and nothing threw.
      expect(rowCount.n).toBe(2)
      // Waited for something close to the holder's own hold time, not
      // returned instantly — proves this genuinely blocked on the lock
      // (`busy_timeout` doing its job) rather than, say, racing in ahead of
      // the holder for an unrelated reason.
      expect(elapsedMs).toBeGreaterThanOrEqual(holdMs * 0.8)
    } finally {
      closeDatabase(db)
      await holder.waitForExit()
    }
  })
})
