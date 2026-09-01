#!/usr/bin/env node
/**
 * CLI entry point for `npm run db:migrate` (built into `dist/run-migrate.js`).
 *
 * Runs `runMigrations` against `CONFIG.DATABASE_PATH` — in production that is
 * `data/data.db`, the live database holding real students' names, emails and
 * conversations, so a plain `npm run db:migrate` refuses to touch a path
 * under `data/` unless it is given `--i-know`. This is the same category of
 * guard as `.claude/hooks/guard-paths.sh`, applied to a command an operator
 * runs by hand rather than to an agent's tool calls.
 */

import { pathToFileURL } from 'node:url'

import { CONFIG } from '@bloombot/config'
import { createLogger } from '@bloombot/logger'

import { closeDatabase, openDatabase } from './client.js'
import { runMigrations } from './migrate.js'
import { isUnderRepoData } from './path-guard.js'

/**
 * Refuse a migration path under this repository's `data/` unless the caller
 * passed `--i-know`.
 *
 * A plain function rather than inline in `main` so it can be unit tested
 * without spawning the CLI or opening a database. `isUnderRepoData`
 * (`path-guard.ts`) compares the *real* path — resolved through the
 * filesystem, following any symlink — against the *real* `data/` directory,
 * so `./data/data.db`, `data/data.db`, an absolute path, and a symlink that
 * points into `data/` from somewhere else entirely all trip the same guard,
 * while a `tmp/` path under some unrelated directory that merely happens to
 * be named `data` does not.
 */
export function assertMigratablePath(path: string, argv: string[]): void {
  if (isUnderRepoData(path, import.meta.url) && !argv.includes('--i-know')) {
    throw new Error(
      `Refusing to migrate '${path}': it is under data/, which holds the live ` +
        'student database. Re-run with --i-know if this is really intended.'
    )
  }
}

function main(): void {
  const log = createLogger('db-migrate')
  const path = CONFIG.DATABASE_PATH

  assertMigratablePath(path, process.argv.slice(2))

  const db = openDatabase(path)
  try {
    log.info({ path }, 'applying migrations')
    runMigrations(db)
    log.info({ path }, 'migrations applied')
  } finally {
    closeDatabase(db)
  }
}

// PLAT-5: run only when this file is the process entry point, not when it is
// imported — e.g. by a test enumerating every module in the package to prove
// none of them has an import-time side effect.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
