/**
 * Repository for `discord_gateway_status` (SURF-9 rework round 2, MF-B).
 *
 * A single durable row: the last moment `apps/bot` is *known* to have been
 * connected to the Discord gateway. Never pruned, never keyed on a message —
 * unlike `discord-handled-messages.ts`, whose own rows are deliberately
 * swept to bound growth (and, the whole reason this table exists, cannot
 * therefore serve as a catch-up scan's own window floor: pruning it deletes
 * the very row that floor read). `apps/bot`'s own `connected-marker.ts`
 * upserts this row periodically while connected and once more on a clean
 * shutdown; `catch-up.ts`'s own scan reads it once per run.
 */

import { eq } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { discordGatewayStatus } from '../schema.js'

/** The one row this table ever holds — `schema.ts`'s own primary key is what actually enforces there is only ever one. */
const SINGLETON_ID = 'singleton'

/**
 * Record `now` as the last known connected moment — an upsert, not an
 * insert: the same row is overwritten every time, never a growing history.
 */
export function recordLastKnownConnected(now: number, db: Executor): void {
  db.insert(discordGatewayStatus)
    .values({ id: SINGLETON_ID, lastKnownConnectedAt: now })
    .onConflictDoUpdate({
      target: discordGatewayStatus.id,
      set: { lastKnownConnectedAt: now },
    })
    .run()
}

/**
 * The last known connected moment, or `undefined` before this process (or
 * any prior one sharing this database) has ever recorded one — the same
 * "no known baseline, so scan nothing" cold-start signal
 * `discord-handled-messages.ts#maxHandledAt` used to be read for, before
 * this table replaced it as the catch-up scan's own window floor.
 */
export function getLastKnownConnectedAt(db: Executor): number | undefined {
  const row = db
    .select({ lastKnownConnectedAt: discordGatewayStatus.lastKnownConnectedAt })
    .from(discordGatewayStatus)
    .where(eq(discordGatewayStatus.id, SINGLETON_ID))
    .get()
  return row?.lastKnownConnectedAt
}
