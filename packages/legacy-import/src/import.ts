/**
 * MIG-1..4's orchestration: read the legacy snapshot and `bot_config.yml`,
 * write both into the platform schema through `packages/db`'s repos, and
 * report what happened.
 *
 * **Natural keys, and the one exception.** MIG-4 asks that re-running the
 * importer against the same snapshot change nothing the second time.
 * Everywhere a natural key already exists in the schema, this package
 * matches on it instead of inventing an id:
 *  - the organization: a deterministic id derived from `server.name`
 *    (`import-config.ts`) — there is no `organizations.name` uniqueness
 *    constraint to look up against, so the id itself has to be the stable
 *    thing;
 *  - the project: looked up by name inside that (already stable)
 *    organization;
 *  - a course: matched by its title within its project;
 *  - a person: matched by the Discord snowflake on `person_identities`
 *    (PPL-2's own uniqueness rule).
 *
 * A message has no natural key at all — `messages` carries no unique column
 * beyond its own id, and two different legacy rows can carry identical
 * content, category, channel and direction. So `import-messages.ts` derives
 * a deterministic id from `(organizationId, legacy message id)` and checks
 * each conversation's transcript for it before appending — recorded here,
 * as the brief asks, and in `docs/DECISIONS.md`.
 *
 * **Importing the same snapshot into two different organizations.** The
 * organization id is derived from `server.name`, not from the snapshot
 * path — so running this importer twice with the *same* snapshot but two
 * *different* YAML files (different `server.name`) produces two
 * organizations, each independently populated: person and course lookups
 * are scoped by `organizationId` (TEN-2), so organization B's import sees
 * none of organization A's already-imported rows, and re-does the full
 * create path for its own copy. Message ids are safe across this too — they
 * embed `organizationId` — so nothing collides on the shared `messages`
 * table. Running the importer twice with the *same* YAML (and therefore the
 * same derived organization id) is the MIG-4 case above: idempotent, not a
 * second organization.
 */

import { closeDatabase, type Database } from '@bloombot/db'

import { assertLegacySnapshotPath } from './guard.js'
import {
  importConfig,
  loadLegacyConfig,
  type CourseImportOutcome,
} from './import-config.js'
import { loadRoutableCourses, importMessages } from './import-messages.js'
import type { ImportMessagesResult } from './import-messages.js'
import { importPeople, type PersonImportOutcome } from './import-people.js'
import {
  openLegacySnapshot,
  readLegacyMessages,
  readLegacyUsers,
} from './read-legacy.js'

/** What `runImport` needs. */
export interface RunImportOptions {
  /** Path to a *copy* of the legacy SQLite database — never the live file (MIG-1). */
  snapshotPath: string
  /** Path to `bot_config.yml` (or an equivalent). */
  yamlPath: string
  /** An already-migrated platform database connection. */
  db: Database
  /** Forwarded to `importConfig` — see its module comment for the default. */
  projectName?: string
}

/** The full report `runImport` returns — what it created, matched, and could not place (MIG-4). */
export interface ImportReport {
  organization: { id: string; created: boolean }
  project: { id: string; created: boolean }
  courses: {
    created: number
    matched: number
    skipped: number
    conflicts: CourseImportOutcome[]
  }
  people: {
    created: number
    matched: number
    skipped: number
    skippedReasons: PersonImportOutcome[]
  }
  messages: ImportMessagesResult
}

/**
 * Run the whole import. Reads the legacy snapshot read-only, closes it
 * before returning (even on failure), and never writes to it — see
 * `guard.ts` (MIG-1) and `read-legacy.ts`.
 */
export function runImport(options: RunImportOptions): ImportReport {
  const { snapshotPath, yamlPath, db, projectName } = options

  assertLegacySnapshotPath(snapshotPath)

  const legacyDb = openLegacySnapshot(snapshotPath)
  let legacyUsers
  let legacyMessages
  try {
    legacyUsers = readLegacyUsers(legacyDb)
    legacyMessages = readLegacyMessages(legacyDb)
  } finally {
    legacyDb.close()
  }

  const config = loadLegacyConfig(yamlPath)
  const configResult = importConfig(
    config,
    db,
    projectName === undefined ? {} : { projectName }
  )

  const peopleOutcomes = importPeople(
    configResult.organizationId,
    legacyUsers,
    db
  )
  const personByLegacyUserId = new Map<number, string>()
  for (const outcome of peopleOutcomes) {
    if (outcome.ok)
      personByLegacyUserId.set(outcome.legacyUserId, outcome.personId)
  }

  const importedCourseIds = configResult.courses
    .filter(
      (outcome): outcome is Extract<CourseImportOutcome, { ok: true }> =>
        outcome.ok
    )
    .map((outcome) => outcome.courseId)
  const routableCourses = loadRoutableCourses(
    configResult.organizationId,
    importedCourseIds,
    db
  )

  const messagesResult = importMessages(
    configResult.organizationId,
    legacyMessages,
    personByLegacyUserId,
    routableCourses,
    db
  )

  const courseConflicts = configResult.courses.filter((outcome) => !outcome.ok)
  const peopleSkipped = peopleOutcomes.filter((outcome) => !outcome.ok)

  return {
    organization: {
      id: configResult.organizationId,
      created: configResult.organizationCreated,
    },
    project: {
      id: configResult.projectId,
      created: configResult.projectCreated,
    },
    courses: {
      created: configResult.courses.filter((o) => o.ok && o.created).length,
      matched: configResult.courses.filter((o) => o.ok && !o.created).length,
      skipped: courseConflicts.length,
      conflicts: courseConflicts,
    },
    people: {
      created: peopleOutcomes.filter((o) => o.ok && o.created).length,
      matched: peopleOutcomes.filter((o) => o.ok && !o.created).length,
      skipped: peopleSkipped.length,
      skippedReasons: peopleSkipped,
    },
    messages: messagesResult,
  }
}

/**
 * Whether `report` left anything unplaced: a message no course's category
 * claimed, a course PROJ-3 refused, or a legacy user with no `discord_id` to
 * key a person on. `cli.ts` exits non-zero exactly when this is `true` — a
 * plain function, not inlined there, so the exit-code decision is testable
 * without spawning the CLI as a process.
 */
export function reportHasUnplaced(report: ImportReport): boolean {
  return (
    report.messages.unplaceable.length > 0 ||
    report.courses.skipped > 0 ||
    report.people.skipped > 0
  )
}

// Re-exported so `closeDatabase` is available to a caller of `runImport`
// (the CLI) without also needing to import `@bloombot/db` directly for it.
export { closeDatabase }
