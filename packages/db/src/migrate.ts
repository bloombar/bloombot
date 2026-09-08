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
 */
export function runMigrations(db: Database): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}
