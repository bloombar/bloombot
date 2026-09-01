/**
 * Loads a `.env` file into the process environment (CFG-5).
 *
 * The Python system this replaces calls `python-dotenv` in every entry point,
 * which is why `.env` is where its credentials live. The TypeScript processes
 * had no equivalent: `.env` was written, documented in `docs/RUNNING_LOCALLY.md`
 * and read by nobody, so `npm run api:dev` on a correctly configured checkout
 * failed at startup naming variables that were sitting in the file all along.
 *
 * Two properties matter and both come from `process.loadEnvFile`, built into
 * Node rather than a dependency:
 *
 *   - **A real environment variable wins.** Values already in `process.env` are
 *     left alone, so a deployment that sets them properly is never overridden by
 *     a stray file, and `NODE_ENV=test` from a test runner survives.
 *   - **Nothing happens at import time** (PLAT-5). This is a function an entry
 *     point calls before it touches `CONFIG`, not a side effect of loading a
 *     module.
 *
 * A missing file is not an error: production sets its environment properly and
 * has no `.env` at all.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the repository's own `.env` lives, relative to this file. */
const repositoryEnvFile = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')

export interface LoadDotEnvResult {
  /** Whether a file was found and loaded. */
  loaded: boolean
  /** The path considered, whether or not it existed. */
  path: string
}

/**
 * Load `.env` into `process.env`, leaving any variable that is already set.
 *
 * Call this at the top of a process's `main()`, before anything reads `CONFIG`
 * — the configuration proxy validates the whole environment on first access, so
 * a read that happens first fails on values this would have supplied.
 *
 * @param path where to look; defaults to the repository root's `.env`.
 */
export function loadDotEnv(
  path: string = repositoryEnvFile()
): LoadDotEnvResult {
  if (!existsSync(path)) return { loaded: false, path }
  process.loadEnvFile(path)
  return { loaded: true, path }
}
