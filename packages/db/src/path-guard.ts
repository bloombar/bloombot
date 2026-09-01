/**
 * Shared filesystem-real path resolution for anything that must refuse this
 * repository's own `data/` directory — the live student database.
 *
 * Extracted out of `run-migrate.ts` (`db:migrate`'s `--i-know` guard) so
 * `packages/legacy-import`'s importer guard (MIG-1, no `--i-know` escape
 * hatch there) can compare against the *same* real `data/` directory the
 * same way, rather than two independently-written guards drifting apart on
 * some edge case one of them handles and the other does not.
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve `path` the way the filesystem actually would: follow any symlink
 * along it to where it really points, not just textually collapse `..`
 * segments the way `resolve()` alone does. The target may not exist yet (a
 * migration or import destination `openDatabase` creates, or a `tmp/`
 * parent that has not been created yet) — `realpathSync` throws on a path
 * that does not exist, so this walks up to the nearest ancestor that *does*
 * exist, resolves that through the filesystem, and rejoins the
 * not-yet-existing tail unchanged.
 */
export function resolveReal(path: string): string {
  const resolved = resolve(path)
  const tail: string[] = []
  let ancestor = resolved
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return resolved // reached the filesystem root
    tail.unshift(basename(ancestor))
    ancestor = parent
  }
  const real = realpathSync(ancestor)
  return tail.length === 0 ? real : join(real, ...tail)
}

/**
 * This repository's own `data/` directory, resolved the same way any
 * candidate path is — not a bare `data` path segment, which is both too
 * broad (a droplet deployed under e.g. `/srv/data/bloombot` would trip the
 * guard for every path, including a harmless `tmp/` one) and too narrow (a
 * symlink elsewhere pointing *at* this directory would not).
 *
 * `moduleUrl` is the caller's own `import.meta.url` — every caller today
 * (`run-migrate.ts`, `packages/legacy-import/src/guard.ts`) lives three
 * directories below the repository root (`packages/<name>/src/<file>.ts`),
 * so walking up three levels from the caller's own directory lands on the
 * repository root the same way regardless of which package calls this.
 */
export function repoDataDir(moduleUrl: string): string {
  return resolveReal(
    resolve(dirname(fileURLToPath(moduleUrl)), '../../../data')
  )
}

/**
 * Whether `path` resolves (through the filesystem, following any symlink)
 * into this repository's own `data/` directory. `moduleUrl` is the caller's
 * `import.meta.url`, threaded through to `repoDataDir` above.
 */
export function isUnderRepoData(path: string, moduleUrl: string): boolean {
  const real = resolveReal(path)
  const dataDir = repoDataDir(moduleUrl)
  return real === dataDir || real.startsWith(`${dataDir}${sep}`)
}
