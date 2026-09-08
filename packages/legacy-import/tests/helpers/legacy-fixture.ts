/**
 * Test helper: a throwaway, legacy-shaped SQLite database under `tmp/`.
 *
 * Mirrors `models/user.py` and `models/message.py`'s column shape (peewee's
 * default field-name-to-column-name mapping) closely enough for
 * `read-legacy.ts` to read it, without ever touching `data/data.db` — a
 * synthetic fixture, never the real snapshot (QA-2, QA-3).
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'

const TMP_ROOT = join(process.cwd(), 'tmp', 'legacy-import-tests')

/** Fields for one legacy `users` row (all optional, so a test only states what it cares about). */
export interface LegacyFixtureUser {
  discordId?: string | null
  discordUsername?: string | null
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  githubUsername?: string | null
  /** Defaults to "now", formatted the way peewee would write it. */
  createdAt?: string
}

/** Fields for one legacy `messages` row. */
export interface LegacyFixtureMessage {
  userId: number
  content: string
  category: string
  channel: string
  direction: 'to' | 'from'
  /** Defaults to "now", formatted the way peewee would write it. */
  createdAt?: string
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * Format `ms` the way peewee stores a Python `datetime` into SQLite: a
 * space-separated, microsecond-precision, timezone-free string
 * (`read-legacy.ts#parseLegacyTimestamp`'s counterpart) — built from the
 * *local* time components of `ms`, so the round trip through
 * `parseLegacyTimestamp` (which reads a timezone-free string as local time,
 * matching Python's naive `datetime.now()`) lands back on exactly `ms`.
 */
export function formatLegacyTimestamp(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  const seconds = pad(date.getSeconds())
  const millis = pad(date.getMilliseconds(), 3)
  // peewee/Python format microseconds; the trailing zeros make this a
  // microsecond value whose first three digits are the millisecond value
  // above, so truncating back to milliseconds in `parseLegacyTimestamp` is
  // exact.
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}000`
}

export interface LegacyFixture {
  path: string
  insertUser: (user: LegacyFixtureUser) => number
  insertMessage: (message: LegacyFixtureMessage) => number
  /** Closes the write handle used to build the fixture — call before importing from it. */
  close: () => void
  /** Deletes the fixture file. Call in `afterEach`. */
  cleanup: () => void
}

/** Create a fresh legacy-shaped SQLite database under `tmp/` with empty `users` and `messages` tables. */
export function createLegacyFixture(): LegacyFixture {
  mkdirSync(TMP_ROOT, { recursive: true })
  const path = join(TMP_ROOT, `${randomUUID()}.db`)
  const db = new BetterSqlite3(path)

  db.exec(`
    create table users (
      id integer primary key autoincrement,
      created_at text not null,
      updated_at text not null,
      discord_id integer unique,
      discord_username text,
      email text,
      last_name text,
      first_name text,
      github_username text
    );
    create table messages (
      id integer primary key autoincrement,
      created_at text not null,
      updated_at text not null,
      content text not null,
      category text not null,
      channel text not null,
      direction text not null,
      user_id integer not null references users(id)
    );
  `)

  const insertUserStatement = db.prepare(
    `insert into users
       (created_at, updated_at, discord_id, discord_username, email, last_name, first_name, github_username)
     values (@createdAt, @createdAt, @discordId, @discordUsername, @email, @lastName, @firstName, @githubUsername)`
  )
  const insertMessageStatement = db.prepare(
    `insert into messages (created_at, updated_at, content, category, channel, direction, user_id)
     values (@createdAt, @createdAt, @content, @category, @channel, @direction, @userId)`
  )

  return {
    path,
    insertUser: (user) => {
      const result = insertUserStatement.run({
        createdAt: user.createdAt ?? formatLegacyTimestamp(Date.now()),
        discordId: user.discordId ?? null,
        discordUsername: user.discordUsername ?? null,
        email: user.email ?? null,
        lastName: user.lastName ?? null,
        firstName: user.firstName ?? null,
        githubUsername: user.githubUsername ?? null,
      })
      return Number(result.lastInsertRowid)
    },
    insertMessage: (message) => {
      const result = insertMessageStatement.run({
        createdAt: message.createdAt ?? formatLegacyTimestamp(Date.now()),
        content: message.content,
        category: message.category,
        channel: message.channel,
        direction: message.direction,
        userId: message.userId,
      })
      return Number(result.lastInsertRowid)
    },
    close: () => db.close(),
    cleanup: () => {
      rmSync(path, { force: true })
    },
  }
}
