/**
 * Test helper: a throwaway, already-migrated platform SQLite database per
 * test file — the same shape `apps/api/tests/helpers/test-db.ts` and
 * `packages/actions/tests/helpers/test-db.ts` use, duplicated rather than
 * imported across an app boundary test helpers are not published through.
 * Lives under `tmp/`, never `data/` (QA-2, QA-3).
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import type { Database } from '@bloombot/db'

const TMP_ROOT = join(process.cwd(), 'tmp', 'mcp-tests')

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
