/**
 * MIG-1's refusal: the importer never opens the live database.
 *
 * The running bot is still serving students while an import is being
 * rehearsed, and `data/data.db` holds their names, emails and transcripts —
 * so the importer takes the path of a *copy* and refuses to open the live
 * file at all. Unlike `db:migrate` (`packages/db/src/run-migrate.ts`), there
 * is no `--i-know` escape hatch here: a migration sometimes has to run
 * against the live file (that is the point of `db:migrate`), but an import
 * against it is never right — the importer's own reads would be competing
 * with the running bot for the same file, and an import is by definition
 * something that can be rehearsed against a snapshot as many times as it
 * takes to get right.
 *
 * Reuses `@bloombot/db`'s `isUnderRepoData` (extracted from `run-migrate.ts`
 * into `packages/db/src/path-guard.ts` for exactly this reuse) rather than
 * writing a second, subtly different path-resolution guard.
 */

import { isUnderRepoData } from '@bloombot/db'

/**
 * Refuse `path` if it resolves (through the filesystem, following any
 * symlink) into this repository's own `data/` directory.
 *
 * A plain function, not inline in the CLI, so it can be unit tested without
 * spawning a process or opening a database — the same shape
 * `assertMigratablePath` (`packages/db/src/run-migrate.ts`) takes.
 */
export function assertLegacySnapshotPath(path: string): void {
  if (isUnderRepoData(path, import.meta.url)) {
    throw new Error(
      `Refusing to import from '${path}': it is under data/, which holds the ` +
        'live student database. Point the importer at a copy instead — ' +
        'there is no override for this guard.'
    )
  }
}
