/**
 * Applies the SQL files under `migrations/` to a database.
 *
 * Nothing here runs at import time (PLAT-5): `runMigrations` takes an
 * already-open `Database`, so importing this module opens nothing.
 */

import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import type { Database } from './client.js'

// Resolved from this file's own location, not `process.cwd()`, so migrations
// apply correctly whether this runs from the package directory, the monorepo
// root, or a compiled `dist/migrate.js` — `dist/` mirrors `src/`'s depth, so
// the same `../migrations` reaches `packages/db/migrations` either way.
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../migrations', import.meta.url)
)

/**
 * Apply every migration under `migrations/` that has not already run.
 *
 * Idempotent: drizzle-orm records applied migrations in a
 * `__drizzle_migrations` table inside the same database, so calling this
 * twice against the same file is a no-op the second time.
 *
 * PROJ-7 — `foreign_keys` is toggled off *here*, at the connection level,
 * around the whole batch, not left to a migration file's own `PRAGMA
 * foreign_keys=OFF;` (drizzle-kit's own SQLite "rebuild the table" output
 * for a column whose constraint cannot be `ALTER`ed in place, such as
 * `0026_clear_stingray.sql` dropping `courses.admins_role`/`students_role`'s
 * `NOT NULL`). SQLite only lets `foreign_keys` change *outside* a pending
 * transaction, and drizzle-orm's own `migrate()` (`node_modules/drizzle-orm/sqlite-core/dialect.js`)
 * wraps every pending migration file in one `BEGIN`/`COMMIT` — so a
 * `PRAGMA` inside the file itself is a silent no-op, and `DROP TABLE
 * courses` then fails outright with a foreign key error the moment any
 * other table (`course_categories`, `transcript_access_log`, …) holds a row
 * referencing it. Restored in a `finally` — `openDatabase`'s own `foreign_keys
 * = ON` (`client.ts`'s own comment) must hold for every query this
 * connection runs afterward, migration failure included.
 */
export function runMigrations(db: Database): void {
  db.$client.pragma('foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    db.$client.pragma('foreign_keys = ON')
  }
}
