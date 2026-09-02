#!/usr/bin/env node
/**
 * CLI entry point for `npm run legacy:import` (built into `dist/cli.js`).
 *
 * Takes the snapshot path and the `bot_config.yml` path, runs the whole
 * import against `CONFIG.DATABASE_PATH` (the platform database), prints the
 * report, and exits non-zero if anything could not be placed — a course
 * PROJ-3 refused, a legacy user with no `discord_id` to key a person on, or
 * a message whose category matched no course (MIG-4).
 */

import { pathToFileURL } from 'node:url'

import { CONFIG, loadDotEnv } from '@bloombot/config'
import { openDatabase, runMigrations } from '@bloombot/db'
import { createLogger } from '@bloombot/logger'

import { assertImportDestinationPath } from './guard.js'
import {
  runImport,
  closeDatabase,
  reportHasUnplaced,
  type ImportReport,
} from './import.js'

function printReport(report: ImportReport): void {
  console.log(JSON.stringify(report, null, 2))
  console.log(
    `\norganization: ${report.organization.created ? 'created' : 'matched'} (${report.organization.id})`
  )
  console.log(
    `project: ${report.project.created ? 'created' : 'matched'} (${report.project.id})`
  )
  console.log(
    `courses: ${report.courses.created} created, ${report.courses.matched} matched, ${report.courses.skipped} skipped`
  )
  console.log(
    `people: ${report.people.created} created, ${report.people.matched} matched, ${report.people.skipped} skipped`
  )
  console.log(
    `messages: ${report.messages.created} created, ${report.messages.matched} matched, ${report.messages.unplaceable.length} unplaceable`
  )
}

function main(): void {
  // OPS-9 (found while walking the cutover rehearsal end to end) — every
  // other entry point (`apps/*/src/index.ts`, `packages/db/src/run-migrate.ts`,
  // CFG-5) loads `.env` before touching `CONFIG`; this CLI did not, so
  // `npm run legacy:import` only ever saw `DATABASE_PATH` when it was
  // already exported in the shell, and threw `EnvValidationError` on a
  // checkout whose credentials live only in `.env`, the same gap
  // `run-migrate.ts` had.
  loadDotEnv()

  const log = createLogger('legacy-import')
  const argv = process.argv.slice(2)
  const [snapshotPath, yamlPath] = argv.filter((arg) => arg !== '--i-know')

  if (!snapshotPath || !yamlPath) {
    console.error(
      'Usage: legacy:import <path-to-snapshot.db> <path-to-bot_config.yml> [--i-know]'
    )
    process.exitCode = 1
    return
  }

  // MIG-1 (finding 1): refuse the *destination* platform database before it
  // is ever opened — this used to run `openDatabase`/`runMigrations` first
  // and only validate the *source* snapshot path once `runImport` started,
  // so a bare `npm run legacy:import` with no `DATABASE_PATH` override
  // migrated and wrote straight into the live student database.
  assertImportDestinationPath(CONFIG.DATABASE_PATH, argv)

  const db = openDatabase(CONFIG.DATABASE_PATH)
  try {
    // Idempotent, so it is safe to apply on every run — a fresh platform
    // database works out of the box without a separate `db:migrate` step
    // the operator has to remember.
    runMigrations(db)

    log.info({ snapshotPath, yamlPath }, 'starting legacy import')
    const report = runImport({ snapshotPath, yamlPath, db })
    printReport(report)

    if (reportHasUnplaced(report)) {
      log.warn({ report }, 'legacy import finished with unplaced rows')
      process.exitCode = 1
    } else {
      log.info({ report }, 'legacy import finished')
    }
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
