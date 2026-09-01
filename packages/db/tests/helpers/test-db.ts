/**
 * Test helper: a throwaway, already-migrated SQLite database per test file.
 *
 * Lives under `tmp/`, never `data/` — CLAUDE.md is explicit that test
 * databases must never point at `data/data.db`, which holds real students'
 * names, emails and conversations (QA-2, QA-3). Each call gets its own file,
 * and `cleanup()` closes the handle and deletes it (plus its WAL/SHM
 * siblings) so a test run leaves nothing behind.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import type { Database } from '@bloombot/db'

const TMP_ROOT = join(process.cwd(), 'tmp', 'db-tests')

export interface TestDatabase {
  db: Database
  path: string
  /** Closes the connection and deletes the file. Call in `afterEach`. */
  cleanup: () => void
}

/** Open a fresh SQLite file under `tmp/` and apply every migration to it. */
export function createTestDatabase(): TestDatabase {
  mkdirSync(TMP_ROOT, { recursive: true })
  const path = join(TMP_ROOT, `${randomUUID()}.db`)

  const db = openDatabase(path)
  runMigrations(db)

  return {
    db,
    path,
    cleanup: () => {
      closeDatabase(db)
      // SQLite in WAL mode (client.ts) writes `-wal` and `-shm` siblings
      // alongside the main file; all three need to go.
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${path}${suffix}`, { force: true })
      }
    },
  }
}
