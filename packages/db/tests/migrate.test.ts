import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import type { Database } from '@bloombot/db'

let dir: string
let db: Database | undefined

afterEach(() => {
  if (db) closeDatabase(db)
  db = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** Table and column names present in a freshly migrated database. */
function introspect(database: Database): Record<string, string[]> {
  const tables = database.$client
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
    )
    .all() as { name: string }[]

  const schema: Record<string, string[]> = {}
  for (const { name } of tables) {
    const columns = database.$client
      .prepare(`pragma table_info(${name})`)
      .all() as { name: string }[]
    schema[name] = columns.map((c) => c.name).sort()
  }
  return schema
}

describe('runMigrations', () => {
  it('applies every migration to an empty database', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    runMigrations(db)

    const schema = introspect(db)
    expect(Object.keys(schema).sort()).toEqual([
      '__drizzle_migrations',
      'accounts',
      'discord_server_bindings',
      'memberships',
      'organizations',
    ])
    expect(schema.organizations).toEqual([
      'created_at',
      'id',
      'is_personal',
      'name',
    ])
    expect(schema.accounts).toEqual([
      'created_at',
      'disabled_at',
      'display_name',
      'email',
      'id',
    ])
    expect(schema.memberships).toEqual([
      'account_id',
      'created_at',
      'organization_id',
      'role',
    ])
    expect(schema.discord_server_bindings).toEqual([
      'installed_at',
      'installed_by_account_id',
      'organization_id',
      'removed_at',
      'server_id',
    ])
  })

  it('is idempotent: running it twice on the same file is a no-op', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    runMigrations(db)
    const after1 = introspect(db)

    expect(() => runMigrations(db as Database)).not.toThrow()
    const after2 = introspect(db)

    expect(after2).toEqual(after1)
  })
})
