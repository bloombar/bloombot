/**
 * This process's own health endpoint — the same shape and the same real
 * round trip `apps/api`'s own `health.ts` already uses, duplicated rather
 * than imported across an app boundary apps do not share (`apps/worker`'s
 * own `health.ts` makes the same call).
 */

import type { Database } from '@bloombot/db'

export interface HealthStatus {
  ready: boolean
  database: boolean
}

/** A cheap, real round trip to the database, checked fresh on every call rather than cached from the moment it last changed. */
export function checkHealth(db: Database): HealthStatus {
  let database = true
  try {
    db.$client.prepare('select 1').get()
  } catch {
    database = false
  }
  return { ready: database, database }
}
