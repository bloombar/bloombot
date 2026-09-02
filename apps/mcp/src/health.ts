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
 */

import type { Database } from '@bloombot/db'

export interface HealthStatus {
  ready: boolean
  database: boolean
  /** How many MCP sessions `server.ts`'s own session map currently holds — read fresh on every call, never cached. */
  sessions: number
}

/** A cheap, real round trip to the database, checked fresh on every call rather than cached from the moment it last changed. `sessionCount` is read straight off `server.ts`'s own session map size — a plain number, not anything this function has to compute itself. */
export function checkHealth(db: Database, sessionCount: number): HealthStatus {
  let database = true
  try {
    db.$client.prepare('select 1').get()
  } catch {
    database = false
  }
  return { ready: database, database, sessions: sessionCount }
}
