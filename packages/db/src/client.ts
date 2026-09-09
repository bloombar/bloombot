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
 *  - `busy_timeout = 5000`, so a writer that arrives while another write
 *    already holds the write lock waits up to 5s for it instead of failing
 *    immediately with `SQLITE_BUSY`. This only covers a transaction that
 *    takes the write lock *up front* (`BEGIN IMMEDIATE`) — see
 *    `writeTransaction`, below, for why a plain `db.transaction(...)` (a
 *    deferred `BEGIN`) does not get this protection at all.
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
 * The subset of `Database`'s query methods a repo function needs when it may
 * be called either with a top-level connection, or from inside a caller's
 * already-open transaction — `db.transaction(...)`'s own callback parameter
 * lacks `$client` (it is not a connection you can close), so it does not
 * satisfy `Database` itself, but it does satisfy this. Mirrors the
 * module-private `Executor` type `repos/courses.ts` already defines for its
 * own internal helpers; this one is exported because AUTH-1/AUTH-3's
 * cross-table atomicity (`@bloombot/auth`'s `sign-in.ts`) needs the same
 * shape from *outside* this package, composing `organizations.ts` and
 * `accounts.ts` inside a transaction it owns.
 */
export type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>

/**
 * `Executor` plus `transaction` — for a repo function that opens its own
 * nested transaction (a savepoint, when `db` is already inside one) rather
 * than only reading and writing rows directly. `accounts.ts#createAccount`
 * is the one function in this package that needs it: called with a
 * top-level `Database` it behaves exactly as before (a real transaction);
 * called with another transaction's own `tx` (from `@bloombot/auth`'s
 * `sign-in.ts`, composing a first-time sign-in's organization, account and
 * session in one atomic unit — TEN-1) it opens a savepoint instead, so a
 * later failure in that same outer transaction rolls this back too.
 */
export type TransactingExecutor = Executor & Pick<Database, 'transaction'>

/**
 * The `tx` parameter `writeTransaction`'s own `fn` receives — pulled out of
 * `Database['transaction']` itself with `infer`, rather than restated by
 * hand, so it always matches whatever Drizzle's own callback type actually
 * is.
 */
type WriteTx = Database['transaction'] extends (
  transaction: (tx: infer Tx) => unknown,
  ...rest: never[]
) => unknown
  ? Tx
  : never

/**
 * Run `fn` inside a write transaction, the way every repo function that
 * writes should open one (D-2).
 *
 * `db.transaction(...)` on its own issues a plain `BEGIN`, which SQLite
 * treats as `BEGIN DEFERRED`: it takes a read lock first and only upgrades
 * to a write lock at the transaction's first write. `busy_timeout` (set in
 * `openDatabase`, above) cannot cover that upgrade — honouring it would mean
 * retrying a write after the transaction's own earlier reads may no longer
 * reflect the database, which SQLite refuses to do — so a deferred
 * transaction that loses the upgrade race returns `SQLITE_BUSY`
 * *immediately*, regardless of the pragma. `BEGIN IMMEDIATE` takes the write
 * lock up front instead, so there is no upgrade to fail: `busy_timeout`
 * governs the wait from the very first statement.
 *
 * Every repo function that opens its own top-level transaction should call
 * this instead of `db.transaction(...)` directly, so a future one cannot
 * silently end up deferred by forgetting an option. `db` may also be another
 * transaction's own `tx` (a nested savepoint, `accounts.ts#createAccount`'s
 * case) — `behavior` is meaningless there (a savepoint has no `BEGIN` of its
 * own; it already runs inside whatever lock its outer transaction took) and
 * is simply ignored by drizzle's nested-transaction path, so this is safe to
 * call in both places uniformly.
 */
export function writeTransaction<T>(
  db: Pick<Database, 'transaction'>,
  fn: (tx: WriteTx) => T
): T {
  return db.transaction(fn, { behavior: 'immediate' })
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
