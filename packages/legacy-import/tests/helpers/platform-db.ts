/**
 * Test helper: a throwaway, already-migrated platform SQLite database per
 * test file — the same shape `packages/db/tests/helpers/test-db.ts` uses,
 * duplicated here rather than imported across a package boundary test
 * helpers are not published through. Lives under `tmp/`, never `data/`
 * (QA-2, QA-3).
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import type { Database } from '@bloombot/db'

const TMP_ROOT = join(process.cwd(), 'tmp', 'legacy-import-tests')

export interface TestPlatformDatabase {
  db: Database
  path: string
  cleanup: () => void
}

/** Open a fresh platform SQLite file under `tmp/` and apply every migration to it. */
export function createTestPlatformDatabase(): TestPlatformDatabase {
  mkdirSync(TMP_ROOT, { recursive: true })
  const path = join(TMP_ROOT, `${randomUUID()}-platform.db`)

  const db = openDatabase(path)
  runMigrations(db)

  return {
    db,
    path,
    cleanup: () => {
      closeDatabase(db)
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${path}${suffix}`, { force: true })
      }
    },
  }
}
