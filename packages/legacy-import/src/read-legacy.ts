/**
 * Reads the legacy SQLite snapshot's `users` and `messages` tables.
 *
 * This is the only file in this package that speaks the legacy schema
 * (`models/user.py`, `models/message.py`, `models/base.py`) — everywhere
 * else works in the platform's own shape. The connection is opened
 * `readonly: true` (better-sqlite3), belt-and-suspenders alongside
 * `guard.ts`'s refusal to open the live file at all: this package never
 * writes a single byte to the legacy file, even a snapshot of it.
 *
 * `discord_id` is read as `TEXT` (`CAST(... AS TEXT)`), not the JS number
 * better-sqlite3 would otherwise hand back: a Discord snowflake exceeds
 * `Number.MAX_SAFE_INTEGER`, the same reason `discordServerBindings.serverId`
 * is `text`, not `integer`, in `packages/db/src/schema.ts`.
 */

import BetterSqlite3 from 'better-sqlite3'

/** One `users` row, in the legacy schema's own field names (`models/user.py`). */
export interface LegacyUser {
  id: number
  createdAt: string
  /** `null` when a legacy row predates the bot ever seeing a Discord message from them. */
  discordId: string | null
  discordUsername: string | null
  email: string | null
  firstName: string | null
  lastName: string | null
  githubUsername: string | null
}

/** One `messages` row, in the legacy schema's own field names (`models/message.py`). */
export interface LegacyMessage {
  id: number
  createdAt: string
  content: string
  /** The Discord category name the message occurred in (DATA-4). */
  category: string
  /** The Discord channel name the message occurred in (DATA-4). */
  channel: string
  direction: 'to' | 'from'
  userId: number
}

/** Open the legacy snapshot read-only. Never call this on the live database — see `guard.ts` (MIG-1). */
export function openLegacySnapshot(path: string): BetterSqlite3.Database {
  return new BetterSqlite3(path, { readonly: true })
}

/** Every row in the legacy `users` table. */
export function readLegacyUsers(db: BetterSqlite3.Database): LegacyUser[] {
  const rows = db
    .prepare(
      `select
         id,
         created_at as createdAt,
         cast(discord_id as text) as discordId,
         discord_username as discordUsername,
         email,
         first_name as firstName,
         last_name as lastName,
         github_username as githubUsername
       from users
       order by id asc`
    )
    .all() as LegacyUser[]
  return rows
}

/**
 * Every row in the legacy `messages` table, oldest first (`id asc` — the
 * autoincrement primary key, assigned in the order `response_bot.py` wrote
 * each row, which is the order a transcript needs to be replayed in for
 * `appendMessage`'s per-conversation `sequence` counter to land in the
 * right order — see `import-messages.ts`).
 */
export function readLegacyMessages(
  db: BetterSqlite3.Database
): LegacyMessage[] {
  const rows = db
    .prepare(
      `select
         id,
         created_at as createdAt,
         content,
         category,
         channel,
         direction,
         user_id as userId
       from messages
       order by id asc`
    )
    .all() as LegacyMessage[]
  return rows
}

/**
 * Parse a legacy `created_at`/`updated_at` value into epoch milliseconds.
 *
 * peewee stores a Python `datetime` by handing it to the sqlite3 driver's
 * default adapter, which formats it as `str(dt)` — `'YYYY-MM-DD
 * HH:MM:SS[.ffffff]'`: a space (not `T`) separating date and time, up to
 * microsecond precision, and no timezone (Python's `datetime.now()` is
 * naive local time). This reformats that into the `T`-separated,
 * millisecond-precision, no-timezone form the ECMA-262 date-time string
 * grammar accepts, which `Date.parse` then reads as local time — the same
 * "naive local time" the value was written as.
 *
 * `raw` is typed `string` (`LegacyMessage.createdAt`'s own type, matching
 * the legacy schema's `NOT NULL`), but nothing here validates a snapshot's
 * actual column values at the driver boundary — a corrupted or hand-edited
 * snapshot can still hand this `null` at runtime. That case is given its own
 * message (finding 8 of the MIG-1 rework) rather than falling through to
 * `.trim()` and surfacing as an unrelated `TypeError`.
 */
export function parseLegacyTimestamp(raw: string): number {
  if (raw == null) {
    throw new Error(`Unparseable legacy timestamp: ${String(raw)}`)
  }
  const isoLocal = raw
    .trim()
    .replace(' ', 'T')
    // Truncate microseconds to the milliseconds `Date` understands; leave a
    // value with no fractional seconds at all untouched.
    .replace(/(\.\d{3})\d*$/, '$1')
  const ms = Date.parse(isoLocal)
  if (Number.isNaN(ms)) {
    throw new Error(`Unparseable legacy timestamp: '${raw}'`)
  }
  return ms
}
