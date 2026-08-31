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

import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CONFIG } from '@bloombot/config'
import { createLogger } from '@bloombot/logger'

import { closeDatabase, openDatabase } from './client.js'
import { runMigrations } from './migrate.js'

/**
 * Refuse a migration path under `data/` unless the caller passed `--i-know`.
 *
 * A plain function rather than inline in `main` so it can be unit tested
 * without spawning the CLI or opening a database. Resolves the path first and
 * checks for a `data` path segment, rather than a prefix match on the raw
 * string, so `./data/data.db`, `data/data.db` and an absolute path all trip
 * the same guard.
 */
export function assertMigratablePath(path: string, argv: string[]): void {
  const underData = resolve(path).split(sep).includes('data')
  if (underData && !argv.includes('--i-know')) {
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
