import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import type { Database } from '@bloombot/db'

// Resolved the same way `src/migrate.ts` resolves it — `tests/` sits at the
// same depth under `packages/db` that `src/` does, so `../migrations` reaches
// the real, shipped migration files from here too.
const REAL_MIGRATIONS_DIR = fileURLToPath(
  new URL('../migrations', import.meta.url)
)

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
      'conversations',
      'cost_ledger_entries',
      'course_attachments',
      'course_categories',
      'course_channels',
      'course_instruction_revisions',
      'courses',
      'discord_install_states',
      'discord_server_bindings',
      'jobs',
      'memberships',
      'messages',
      'organizations',
      'people',
      'person_identities',
      'projects',
      'sessions',
      'sign_in_tokens',
      'usage_counters',
    ])
    expect(schema.organizations).toEqual([
      'created_at',
      'id',
      'is_personal',
      'name',
      'spending_cap_micros',
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
    expect(schema.discord_install_states).toEqual([
      'account_id',
      'code_verifier',
      'created_at',
      'expires_at',
      'id',
      'organization_id',
      'state_hash',
      'used_at',
    ])
    expect(schema.projects).toEqual([
      'archived_at',
      'created_at',
      'id',
      'name',
      'organization_id',
    ])
    expect(schema.courses).toEqual([
      'admins_role',
      'conversation_scope',
      'created_at',
      'enabled',
      'file_prefix',
      'id',
      'instructions',
      'max_requests_per_day',
      'model',
      'organization_id',
      'project_id',
      'prompt_id',
      'students_role',
      'title',
      'vector_store_id',
    ])
    expect(schema.course_categories).toEqual([
      'course_id',
      'created_at',
      'id',
      'name',
      'ordering',
      'organization_id',
    ])
    expect(schema.course_channels).toEqual([
      'admins_only',
      'category_id',
      'created_at',
      'id',
      'name',
      'ordering',
      'organization_id',
    ])
    expect(schema.people).toEqual([
      'created_at',
      'display_name',
      'email',
      'first_name',
      'github_handle',
      'id',
      'last_name',
      'organization_id',
    ])
    expect(schema.person_identities).toEqual([
      'created_at',
      'external_id',
      'id',
      'organization_id',
      'person_id',
      'surface',
    ])
    expect(schema.conversations).toEqual([
      'course_id',
      'created_at',
      'id',
      'last_message_at',
      'organization_id',
      'person_id',
      'surface',
      'upstream_thread_id',
    ])
    expect(schema.messages).toEqual([
      'category_ref',
      'channel_ref',
      'content',
      'conversation_id',
      'course_id',
      'created_at',
      'direction',
      'id',
      'organization_id',
      'person_id',
      'sequence',
      'surface',
    ])
    expect(schema.usage_counters).toEqual([
      'count',
      'course_id',
      'day',
      'organization_id',
      'person_id',
    ])
    expect(schema.sign_in_tokens).toEqual([
      'created_at',
      'email',
      'expires_at',
      'id',
      'token_hash',
      'used_at',
    ])
    expect(schema.sessions).toEqual([
      'account_id',
      'created_at',
      'expires_at',
      'id',
      'last_seen_at',
      'revoked_at',
      'token_hash',
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

  // Finding 1 of the CONV-1 rework: 0002 originally rebuilt `courses` with
  // `DROP TABLE courses` behind a `PRAGMA foreign_keys=OFF` that does nothing
  // once drizzle's migrator has opened its own `BEGIN` — so the rebuild was
  // enforced against `course_categories.course_id` on any database that
  // already had a course, and the whole migration rolled back. Every test
  // above starts from an empty file, so none of them exercised this: this
  // one applies 0000 and 0001 only, seeds exactly what one `createCourse`
  // call writes (an organization, a project, a course, a category and a
  // channel — the shape `repos/courses.ts`'s `insertCourseCategories`
  // produces), then applies 0002 on top of that populated database.
  it('applies 0002 to a database that already has a course, without losing it or its children', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    // A migrations folder containing only 0000 and 0001 — the state a
    // database is in before 0002 has ever run.
    const partialMigrationsDir = join(dir, 'partial-migrations')
    mkdirSync(join(partialMigrationsDir, 'meta'), { recursive: true })
    copyFileSync(
      join(REAL_MIGRATIONS_DIR, '0000_flat_doctor_spectrum.sql'),
      join(partialMigrationsDir, '0000_flat_doctor_spectrum.sql')
    )
    copyFileSync(
      join(REAL_MIGRATIONS_DIR, '0001_loving_ulik.sql'),
      join(partialMigrationsDir, '0001_loving_ulik.sql')
    )
    writeFileSync(
      join(partialMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1788217841434,
            tag: '0000_flat_doctor_spectrum',
            breakpoints: true,
          },
          {
            idx: 1,
            version: '6',
            when: 1788221671586,
            tag: '0001_loving_ulik',
            breakpoints: true,
          },
        ],
      })
    )
    migrate(db, { migrationsFolder: partialMigrationsDir })

    // Seed one organization / project / course / category / channel —
    // exactly what a single `createCourse` call writes — with raw SQL,
    // deliberately not through the repo layer: at this point `courses` does
    // not have `conversation_scope` yet, and the repo layer (post-finding-6)
    // always writes it.
    const organizationId = randomUUID()
    const projectId = randomUUID()
    const courseId = randomUUID()
    const categoryId = randomUUID()
    const channelId = randomUUID()
    const now = Date.now()
    db.$client
      .prepare(
        'insert into organizations (id, name, is_personal, created_at) values (?, ?, ?, ?)'
      )
      .run(organizationId, 'Org A', 0, now)
    db.$client
      .prepare(
        'insert into projects (id, organization_id, name, archived_at, created_at) values (?, ?, ?, null, ?)'
      )
      .run(projectId, organizationId, 'Fall 2026', now)
    db.$client
      .prepare(
        `insert into courses
          (id, organization_id, project_id, title, file_prefix, enabled, admins_role, students_role, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        courseId,
        organizationId,
        projectId,
        'Web Design',
        'wd',
        1,
        'admins-wd',
        'students-wd',
        now
      )
    db.$client
      .prepare(
        'insert into course_categories (id, organization_id, course_id, name, ordering, created_at) values (?, ?, ?, ?, ?, ?)'
      )
      .run(categoryId, organizationId, courseId, 'General', 0, now)
    db.$client
      .prepare(
        'insert into course_channels (id, organization_id, category_id, name, admins_only, ordering, created_at) values (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(channelId, organizationId, categoryId, 'general', 0, 0, now)

    // The migration under test: 0002, applied through the real migrations
    // folder (0000 and 0001 are already recorded as applied, by hash, so
    // only 0002 actually runs here).
    runMigrations(db)

    const course = db.$client
      .prepare('select * from courses where id = ?')
      .get(courseId) as { id: string; conversation_scope: string } | undefined
    expect(course).toMatchObject({
      id: courseId,
      conversation_scope: 'course',
    })

    const category = db.$client
      .prepare('select * from course_categories where id = ?')
      .get(categoryId)
    expect(category).toBeDefined()

    const channel = db.$client
      .prepare('select * from course_channels where id = ?')
      .get(channelId)
    expect(channel).toBeDefined()
  })
})
