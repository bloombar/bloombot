/**
 * The SQLite connection every repository function is handed (D-2).
 *
 * Nothing here runs at import time (PLAT-5): no file is opened, no directory is
 * created and no pragma is set until `openDatabase` is actually called. A
 * module that merely imports this file — a test, a type check, a script that
 * never touches the database — has no side effect.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { CONFIG } from '@bloombot/config'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.js'

/**
 * The Drizzle client every repository function takes as its `db` parameter.
 * Derived from `drizzle()`'s own return type (rather than restated by hand)
 * so it always includes `$client`, which `closeDatabase` needs.
 */
export type Database = ReturnType<typeof drizzle<typeof schema>>

/**
 * Open (or create) the SQLite file at `path`, defaulting to `CONFIG.DATABASE_PATH`.
 *
 * Sets three pragmas on every open, per D-2:
 *  - `journal_mode = WAL`, so readers never block a writer or vice versa —
 *    the thing that makes a single SQLite file tolerable with three writing
 *    processes (bot, API, worker) on one droplet.
 *  - `busy_timeout = 5000`, so a writer that arrives while another write is
 *    mid-transaction waits up to 5s for the lock instead of failing
 *    immediately with `SQLITE_BUSY`.
 *  - `foreign_keys = ON`, because SQLite ignores `references()` unless this is
 *    set on every connection — it is not a database-wide setting.
 */
export function openDatabase(path: string = CONFIG.DATABASE_PATH): Database {
  // `:memory:` has no directory to create; every real file path does, and a
  // fresh `tmp/` throwaway database must not fail because its directory
  // does not exist yet.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const client = new BetterSqlite3(path)
  client.pragma('journal_mode = WAL')
  client.pragma('busy_timeout = 5000')
  client.pragma('foreign_keys = ON')

  return drizzle(client, { schema })
}

/**
 * Release the underlying file handle.
 *
 * Tests open a throwaway database per file and must be able to close it
 * before deleting it — on some platforms an open SQLite file (plus its
 * `-wal`/`-shm` siblings) cannot be removed while a handle is still open.
 */
export function closeDatabase(db: Database): void {
  db.$client.close()
}
