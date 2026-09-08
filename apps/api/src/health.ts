/**
 * API-6 — reports whether this process can actually serve, not merely that
 * it is running: its configuration validated (true by the time this module
 * is even reachable — `src/index.ts` touches `CONFIG` before building
 * anything, the same "fail at startup, not on the first request" discipline
 * `apps/bot`'s own `SURF-7` holds itself to) and its database is reachable,
 * checked fresh on every call rather than cached from the moment it last
 * changed.
 */

import type { Database } from '@bloombot/db'

export interface HealthStatus {
  ready: boolean
  database: boolean
}

/**
 * A cheap, real round trip to the database — `db.$client` is the
 * underlying better-sqlite3 handle `closeDatabase` already reaches for the
 * same reason (`@bloombot/db`'s `client.ts`); `prepare('select 1').get()`
 * touches the actual file handle rather than merely checking that a
 * JavaScript object still exists, so a closed or otherwise broken
 * connection is caught here rather than on the next real request.
 */
export function checkHealth(db: Database): HealthStatus {
  let database = true
  try {
    db.$client.prepare('select 1').get()
  } catch {
    database = false
  }
  return { ready: database, database }
}
