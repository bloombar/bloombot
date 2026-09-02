/**
 * Loads `.env` into `process.env` — the same behavior `@bloombot/config`'s
 * own `loadDotEnv` gives every real entry point
 * (`packages/config/src/dotenv.ts`), duplicated here rather than imported,
 * the same "these scripts must run before, or without, a build" reason
 * `scripts/health-check.mjs`'s own module comment already gives for
 * avoiding `@bloombot/config` generally. A value already in `process.env`
 * wins over the file; a missing file is not an error.
 *
 * Rework finding — `scripts/health-check.mjs` and `scripts/ops-monitor.mjs`
 * used to read `process.env` directly with no `.env` load at all, unlike
 * every real entry point in this codebase (each `apps/<name>/src/index.ts`,
 * `packages/db/src/run-migrate.ts`, `packages/legacy-import/src/cli.ts`).
 * `ecosystem.config.cjs`'s own module comment claims "every Node process
 * here loads `.env` itself" — false for `ops-monitor` specifically, since
 * pm2 never loads `.env` on a process's behalf. Two concrete failures
 * followed: `OPS_ALERT_WEBHOOK_URL` never reached the running
 * `ops-monitor` process, so every page silently degraded to a log line
 * nobody was watching; and any `API_PORT`/`BOT_HEALTH_PORT`/
 * `WORKER_HEALTH_PORT`/`MCP_PORT` override in `.env` never reached
 * `scripts/health-check.mjs` when `scripts/deploy.sh` ran it, so a
 * deployment with a non-default port would fail its own health check on
 * every single deploy and roll back forever. See `docs/DECISIONS.md`'s
 * entry for this rework round.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where this repository's own `.env` lives, relative to this file (`scripts/` sits one level below the repo root). */
export function defaultEnvFilePath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')
}

/**
 * Load `path` (defaults to the repository root's `.env`) into `process.env`,
 * leaving any variable that is already set. Returns whether a file was
 * actually found and loaded, so a caller can log it — a missing file is not
 * an error (a production deployment with credentials exported directly,
 * rather than through a file, is a legitimate setup).
 */
export function loadDotEnvOnce(path = defaultEnvFilePath()) {
  if (!existsSync(path)) return false
  process.loadEnvFile(path)
  return true
}
