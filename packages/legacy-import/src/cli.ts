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

import { CONFIG } from '@bloombot/config'
import { openDatabase, runMigrations } from '@bloombot/db'
import { createLogger } from '@bloombot/logger'

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
  const log = createLogger('legacy-import')
  const [snapshotPath, yamlPath] = process.argv.slice(2)

  if (!snapshotPath || !yamlPath) {
    console.error(
      'Usage: legacy:import <path-to-snapshot.db> <path-to-bot_config.yml>'
    )
    process.exitCode = 1
    return
  }

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
