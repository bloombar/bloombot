/**
 * MIG-1's refusal: the importer never opens the live database, for reading
 * *or* writing.
 *
 * Two different paths are in play, and they are guarded differently:
 *
 *  - The *source* snapshot (`assertLegacySnapshotPath`, below). The running
 *    bot is still serving students while an import is being rehearsed, and
 *    `data/data.db` holds their names, emails and transcripts — so the
 *    importer takes the path of a *copy* and refuses to open the live file
 *    at all. Unlike `db:migrate` (`packages/db/src/run-migrate.ts`), there is
 *    no `--i-know` escape hatch here: a migration sometimes has to run
 *    against the live file (that is the point of `db:migrate`), but an
 *    import *from* it is never right — the importer's own reads would be
 *    competing with the running bot for the same file, and an import is by
 *    definition something that can be rehearsed against a snapshot as many
 *    times as it takes to get right.
 *  - The *destination* platform database (`assertImportDestinationPath`,
 *    below) — `cli.ts` opens and migrates `CONFIG.DATABASE_PATH` before
 *    `runImport` ever validates the source path, and that config defaults to
 *    `./data/data.db` (the same live file). Unlike the source, the
 *    destination legitimately *is* the live database once an operator is
 *    ready to run the real import — that is the whole point of migrating —
 *    so this guard takes the same shape `db:migrate`'s own
 *    `assertMigratablePath` does: refused unless the caller passes
 *    `--i-know`.
 *
 * Both reuse `@bloombot/db`'s `isUnderRepoData` (extracted from
 * `run-migrate.ts` into `packages/db/src/path-guard.ts` for exactly this
 * reuse) rather than writing a second, subtly different path-resolution
 * guard.
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

/**
 * Refuse `path` as the import *destination* — the platform database
 * `cli.ts` opens and migrates — if it resolves into this repository's own
 * `data/` directory, unless `argv` carries `--i-know`.
 *
 * Without this, `cli.ts` opened `CONFIG.DATABASE_PATH` (defaulting to
 * `./data/data.db`) and ran migrations against it before `runImport` ever
 * reached `assertLegacySnapshotPath` — so a plain `npm run legacy:import`
 * with no `DATABASE_PATH` override wrote the whole platform schema straight
 * into the live student database. A plain function, not inline in the CLI,
 * for the same testability reason `assertLegacySnapshotPath` is.
 */
export function assertImportDestinationPath(
  path: string,
  argv: string[]
): void {
  if (isUnderRepoData(path, import.meta.url) && !argv.includes('--i-know')) {
    throw new Error(
      `Refusing to import into '${path}': it is under data/, which holds the ` +
        'live student database. Re-run with --i-know if this is really intended.'
    )
  }
}
