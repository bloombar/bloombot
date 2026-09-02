/**
 * This process's own health endpoint — the same real database round trip
 * `apps/api`'s own `health.ts` already uses, duplicated rather than
 * imported across an app boundary apps do not share (`apps/worker`'s own
 * `health.ts` makes the same call), plus one number `apps/api`/`apps/worker`
 * have no equivalent of: how many MCP sessions `server.ts` is currently
 * holding open. The same "surface an internal counter an operator would
 * otherwise have no way to see" idiom `apps/bot`'s own health endpoint
 * already uses for the model provider's running call stats (COST-5) — a
 * process that is up and whose database is reachable can still be quietly
 * accumulating sessions faster than they idle out (`server.ts`'s own
 * `sweepIdleSessions`/`MAX_SESSIONS_PER_ACCOUNT`), and this is the number
 * that would show it.
 *
 * `shuttingDown` (rework finding) reports `ready: false` from the moment a
 * shutdown begins, the same `apps/bot`/`apps/worker` own health endpoints
 * already do for their own `gatewayConnected`/`workerHealthStatus` flags —
 * an earlier version of this endpoint kept reporting `ready: true` for the
 * whole teardown window, which is exactly the "healthy report over a dying
 * process" shape this rework round's finding 6 already fixed once, for
 * `buildToolDefinitions`. The database itself stays open and reachable
 * until `shutdown.ts`'s own `closeDb()` actually runs, so `database` is
 * still a real round trip either way — only `ready` is forced, the same
 * "hardcoding the wrong field reads as an outage, not an orderly shutdown"
 * reasoning `apps/worker/src/health.ts#workerHealthStatus`'s own comment
 * gives for doing the same thing there.
 */

import type { Database } from '@bloombot/db'

export interface HealthStatus {
  ready: boolean
  database: boolean
  /** How many MCP sessions `server.ts`'s own session map currently holds — read fresh on every call, never cached. */
  sessions: number
}

/**
 * A cheap, real round trip to the database, checked fresh on every call
 * rather than cached from the moment it last changed. `sessionCount` is
 * read straight off `server.ts`'s own session map size — a plain number,
 * not anything this function has to compute itself. `shuttingDown`
 * defaults to `false` so every existing caller (most of this app's own
 * tests) is unaffected; `server.ts`'s own `/health` route is the one real
 * caller that ever passes `true`.
 */
export function checkHealth(
  db: Database,
  sessionCount: number,
  shuttingDown = false
): HealthStatus {
  let database = true
  try {
    db.$client.prepare('select 1').get()
  } catch {
    database = false
  }
  return {
    ready: database && !shuttingDown,
    database,
    sessions: sessionCount,
  }
}
