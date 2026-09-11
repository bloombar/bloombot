import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
      'course_join_links',
      'course_self_enrolment_intents',
      'course_web_sources',
      'courses',
      'discord_gateway_status',
      'discord_handled_messages',
      'discord_install_states',
      'discord_server_bindings',
      'enrolments',
      'jobs',
      'mcp_oauth_access_tokens',
      'mcp_oauth_authorization_codes',
      'mcp_oauth_clients',
      'mcp_oauth_pending_authorizations',
      'mcp_oauth_refresh_tokens',
      'membership_invitations',
      'memberships',
      'messages',
      'organizations',
      'people',
      'person_identities',
      'person_link_challenges',
      'projects',
      'roster_channel_assignments',
      'sessions',
      'sign_in_tokens',
      'tenant_deletions',
      'transcript_access_log',
      'transcript_exports',
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
    // ENRL-11 — `revoked_at`/`revoked_by_account_id` added by this slice.
    expect(schema.memberships).toEqual([
      'account_id',
      'created_at',
      'granted_at',
      'granted_by_account_id',
      'organization_id',
      'revoked_at',
      'revoked_by_account_id',
      'role',
    ])
    // ENRL-12 — `secret_ciphertext`/`secret_nonce`/`secret_auth_tag` added by
    // this slice, all three nullable together (this schema's own doc
    // comment above `courseJoinLinks`).
    expect(schema.course_join_links).toEqual([
      'course_id',
      'created_at',
      'created_by_account_id',
      'expires_at',
      'id',
      'organization_id',
      'revoked_at',
      'secret_auth_tag',
      'secret_ciphertext',
      'secret_hash',
      'secret_nonce',
    ])
    expect(schema.discord_server_bindings).toEqual([
      'installed_at',
      'installed_by_account_id',
      'organization_id',
      'removed_at',
      'server_id',
    ])
    // FILE-6/MDL-9 — added by this slice.
    expect(schema.course_web_sources).toEqual([
      'course_id',
      'created_at',
      'domain',
      'id',
      'organization_id',
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
    // ENRL-13/ENRL-14 — `self_enrol_from_discord`/`answer_unenrolled` added
    // by this slice.
    expect(schema.courses).toEqual([
      'admins_role',
      'answer_unenrolled',
      'conversation_scope',
      'created_at',
      'discord_server_id',
      'enabled',
      'id',
      'instructions',
      'max_requests_per_day',
      'model',
      'organization_id',
      'project_id',
      'prompt_id',
      'self_enrol_from_discord',
      'students_role',
      'title',
      'vector_store_id',
    ])
    // ENRL-13 — added by this slice.
    expect(schema.course_self_enrolment_intents).toEqual([
      'course_id',
      'created_at',
      'id',
      'organization_id',
      'person_id',
      'redeemed_at',
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
      'connected_at',
      'created_at',
      'display_name',
      'email',
      'first_name',
      'github_handle',
      'id',
      'last_name',
      'merged_at',
      'merged_into_person_id',
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
      'destination',
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

  // Must-fix 2 of the ADMIN-1..5 rework's third round — reproduced with
  // the real migrator, the same "seed exactly what one write leaves,
  // apply the next migration on top of it" shape the 0002 test above
  // already uses. `0013`'s own `ALTER TABLE transcript_access_log ADD
  // sequence` used to carry no default: SQLite accepts that shape only on
  // an *empty* table, and refuses (rolling the whole migration back, no
  // partial effect) the moment a real deployment already has a single row
  // in it — which any reviewer who ran ADMIN-1's own read even once
  // already does, since `readCourseTranscript` writes exactly one row per
  // read. `apps/api` and `apps/worker` both call `runMigrations` at boot,
  // so this was a process that refused to start on any database that had
  // already seen the first rework round's own code.
  it('applies 0013 to a database that already has a transcript_access_log row, backfilling sequence rather than refusing to start', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    // A migrations folder containing every migration through 0012 — the
    // state a database is in before 0013 has ever run.
    // The real journal's own entries, `when` and all — carried over
    // unchanged, not reinvented with fresh timestamps: the migrator's own
    // "is this migration newer than the last one I applied" check
    // (`node_modules/drizzle-orm/sqlite-core/dialect.js`'s own `migrate`)
    // compares each candidate's `folderMillis` (the journal's `when`)
    // against the *watermark* this partial run leaves behind — inventing
    // smaller `when` values here would leave that watermark behind the
    // real journal's own later entries, and the second `runMigrations`
    // call below would try to re-run 0001..0012 against a database that
    // already has them, failing on `CREATE TABLE` for a table that
    // already exists (a defect in an earlier draft of this very test,
    // caught by running it rather than only reading it).
    const journal = JSON.parse(
      readFileSync(join(REAL_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] }
    const entriesThrough0012 = journal.entries.filter(
      (entry) => Number(entry.tag.slice(0, 4)) <= 12
    )
    const partialMigrationsDir = join(dir, 'partial-migrations')
    mkdirSync(join(partialMigrationsDir, 'meta'), { recursive: true })
    for (const entry of entriesThrough0012) {
      copyFileSync(
        join(REAL_MIGRATIONS_DIR, `${entry.tag}.sql`),
        join(partialMigrationsDir, `${entry.tag}.sql`)
      )
    }
    writeFileSync(
      join(partialMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: entriesThrough0012,
      })
    )
    migrate(db, { migrationsFolder: partialMigrationsDir })

    // Seed exactly what one `readCourseTranscript` call leaves — an
    // organization, an account, a project, a course and one
    // `transcript_access_log` row — with raw SQL, since `sequence` does
    // not exist as a column yet at this point in the migration history.
    const organizationId = randomUUID()
    const accountId = randomUUID()
    const projectId = randomUUID()
    const courseId = randomUUID()
    const logId = randomUUID()
    const now = Date.now()
    db.$client
      .prepare(
        'insert into organizations (id, name, is_personal, created_at) values (?, ?, ?, ?)'
      )
      .run(organizationId, 'Org A', 0, now)
    db.$client
      .prepare(
        'insert into accounts (id, email, display_name, created_at) values (?, ?, ?, ?)'
      )
      .run(accountId, 'instructor@example.edu', 'Instructor', now)
    db.$client
      .prepare(
        'insert into projects (id, organization_id, name, archived_at, created_at) values (?, ?, ?, null, ?)'
      )
      .run(projectId, organizationId, 'Fall 2026', now)
    db.$client
      .prepare(
        `insert into courses
          (id, organization_id, project_id, title, file_prefix, enabled, admins_role, students_role, conversation_scope, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        'course',
        now
      )
    db.$client
      .prepare(
        `insert into transcript_access_log
          (id, organization_id, course_id, actor_account_id, person_id, kind, start_at, end_at, created_at)
         values (?, ?, ?, ?, null, 'read', null, null, ?)`
      )
      .run(logId, organizationId, courseId, accountId, now)

    // The migration under test: 0013, applied through the real migrations
    // folder — this must not throw.
    expect(() => runMigrations(db as Database)).not.toThrow()

    const row = db.$client
      .prepare('select * from transcript_access_log where id = ?')
      .get(logId) as { id: string; sequence: number } | undefined
    expect(row).toMatchObject({ id: logId, sequence: 0 })
  })

  // JOB-6 rework, must-fix — nothing pinned 0016's own `WHERE` clause, the
  // one data-destroying statement this slice wrote, and every test database
  // above is created empty and migrated *before* any job row exists, so an
  // empty `jobs` table never exercised it: replacing `WHERE status in
  // ('succeeded', 'failed')` with an unconditional `UPDATE` left every
  // other test in this file (and the whole suite) green. The same "seed
  // exactly what a real deployment would already have, apply the real
  // migration on top of it" shape the 0002 and 0013 tests above already
  // use — here, one job row per status `claimNextJob`'s own `eligible()`
  // distinguishes (`repos/jobs.ts`'s own module comment): a fresh `pending`
  // job, a `pending` job already rescheduled once and awaiting its next
  // attempt, a `running` job under a still-live lease, a `running` job
  // whose lease has lapsed (eligible for reclaim, but its own `status`
  // column still literally reads `running` — 0016's own `WHERE` matches on
  // that column, not on `eligible()`'s computed lease check), a `succeeded`
  // job, and a `failed` one. Only the last two may lose their payload; the
  // other four are exactly the shapes JOB-2's retry and JOB-3's once-only
  // execution across a worker restart still need theirs for.
  it("applies 0015 and 0016 to a database with a job row in every status, clearing payload only on the terminal ones — proves 0016's own WHERE clause, not merely that the migration runs", () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    // A migrations folder containing every migration through 0014 — the
    // state a database is in before 0015/0016 have ever run, `payload` still
    // `NOT NULL` (0005's own `CREATE TABLE jobs`).
    const journal = JSON.parse(
      readFileSync(join(REAL_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] }
    const entriesThrough0014 = journal.entries.filter(
      (entry) => Number(entry.tag.slice(0, 4)) <= 14
    )
    const partialMigrationsDir = join(dir, 'partial-migrations')
    mkdirSync(join(partialMigrationsDir, 'meta'), { recursive: true })
    for (const entry of entriesThrough0014) {
      copyFileSync(
        join(REAL_MIGRATIONS_DIR, `${entry.tag}.sql`),
        join(partialMigrationsDir, `${entry.tag}.sql`)
      )
    }
    writeFileSync(
      join(partialMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: entriesThrough0014,
      })
    )
    migrate(db, { migrationsFolder: partialMigrationsDir })

    const organizationId = randomUUID()
    const now = Date.now()
    db.$client
      .prepare(
        'insert into organizations (id, name, is_personal, created_at) values (?, ?, ?, ?)'
      )
      .run(organizationId, 'Org A', 0, now)

    // One row per status `eligible()` distinguishes — raw SQL, deliberately
    // not through `enqueueJob`/`completeJob`/etc: those already carry this
    // slice's own fix, and seeding a pre-0015 database means writing rows
    // exactly as a real deployment's own pre-existing rows would look.
    const insertJob = db.$client.prepare(
      `insert into jobs
        (id, organization_id, kind, payload, status, attempts, max_attempts,
         next_attempt_at, claimed_by, claim_expires_at, last_error, result,
         created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const ids = {
      pendingFresh: randomUUID(),
      pendingRetry: randomUUID(),
      runningLive: randomUUID(),
      runningLapsed: randomUUID(),
      succeeded: randomUUID(),
      failed: randomUUID(),
    }
    insertJob.run(
      ids.pendingFresh,
      organizationId,
      'roster.import',
      '{"csvText":"pending-fresh"}',
      'pending',
      0,
      3,
      now,
      null,
      null,
      null,
      null,
      now,
      now
    )
    insertJob.run(
      ids.pendingRetry,
      organizationId,
      'roster.import',
      '{"csvText":"pending-retry"}',
      'pending',
      1,
      3,
      now + 60_000,
      null,
      null,
      'upstream timed out',
      null,
      now,
      now
    )
    insertJob.run(
      ids.runningLive,
      organizationId,
      'roster.import',
      '{"csvText":"running-live"}',
      'running',
      1,
      3,
      now,
      'worker-1',
      now + 60_000,
      null,
      null,
      now,
      now
    )
    insertJob.run(
      ids.runningLapsed,
      organizationId,
      'roster.import',
      '{"csvText":"running-lapsed"}',
      'running',
      1,
      3,
      now,
      'worker-1',
      now - 60_000,
      null,
      null,
      now,
      now
    )
    insertJob.run(
      ids.succeeded,
      organizationId,
      'roster.import',
      '{"csvText":"succeeded"}',
      'succeeded',
      1,
      3,
      now,
      null,
      null,
      null,
      '{"peopleCreated":1}',
      now,
      now
    )
    insertJob.run(
      ids.failed,
      organizationId,
      'roster.import',
      '{"csvText":"failed"}',
      'failed',
      3,
      3,
      now,
      null,
      null,
      'exhausted attempts',
      null,
      now,
      now
    )

    // The migrations under test: 0015 (the table rebuild) and 0016 (the
    // backfill), applied through the real migrations folder.
    runMigrations(db)

    const rows = db.$client
      .prepare('select id, status, payload from jobs order by id')
      .all() as { id: string; status: string; payload: string | null }[]
    // 0015's own table rebuild loses no row.
    expect(rows).toHaveLength(6)

    const byId = new Map(rows.map((row) => [row.id, row]))
    // Not terminal — 0016's own WHERE must leave every one of these alone.
    expect(byId.get(ids.pendingFresh)?.payload).toBe(
      '{"csvText":"pending-fresh"}'
    )
    expect(byId.get(ids.pendingRetry)?.payload).toBe(
      '{"csvText":"pending-retry"}'
    )
    expect(byId.get(ids.runningLive)?.payload).toBe(
      '{"csvText":"running-live"}'
    )
    // `running` with a lapsed lease is eligible for *reclaim*, but its own
    // `status` column still reads `running` — 0016 matches on that column,
    // not on `claimNextJob`'s own computed eligibility — so this, too, must
    // survive.
    expect(byId.get(ids.runningLapsed)?.payload).toBe(
      '{"csvText":"running-lapsed"}'
    )
    // Terminal — 0016 clears exactly these two, and only these two.
    expect(byId.get(ids.succeeded)?.payload).toBeNull()
    expect(byId.get(ids.failed)?.payload).toBeNull()

    // 0015 is the first table-rebuild migration in this schema — pin that
    // the rebuild actually preserves what it claims to, not merely that the
    // row count survives: the index pair `repos/jobs.ts#claimNextJob`
    // itself depends on, and the `jobs_status_check` CHECK constraint.
    // `sqlite_autoindex_jobs_1` (the text primary key's own implicit
    // uniqueness index) is filtered out — an implementation detail SQLite
    // manages on its own, not one of this table's named indexes.
    const indexNames = (
      db.$client
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'jobs'"
        )
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_autoindex'))
      .sort()
    expect(indexNames).toEqual([
      'jobs_organization_id_idx',
      'jobs_status_next_attempt_idx',
    ])

    expect(() =>
      insertJob.run(
        randomUUID(),
        organizationId,
        'roster.import',
        '{}',
        'not-a-real-status',
        0,
        1,
        now,
        null,
        null,
        null,
        null,
        now,
        now
      )
    ).toThrow(/CHECK constraint failed/)
  })

  // ROST-13 — 0023 drops `file_prefix`, a plain column removal with no
  // conditional logic of its own to pin (unlike 0016's `WHERE` or 0013's
  // backfill), so this proves the one thing a plain `ALTER TABLE ... DROP
  // COLUMN` can get wrong: losing a row, or a sibling column's value on it,
  // along with the one being dropped. Same "seed what a real deployment
  // already has, then apply the real migration on top" shape as 0002/0013
  // above — seeded through 0022, the last migration before this one, with
  // every column `file_prefix` sat alongside filled in, not just the
  // required ones, so a value carried on the wrong column would show up as
  // a mismatch here rather than passing by accident on a null default.
  it('applies 0023 to a database that already has a course with a file_prefix, dropping only that column', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    const journal = JSON.parse(
      readFileSync(join(REAL_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] }
    const entriesThrough0022 = journal.entries.filter(
      (entry) => Number(entry.tag.slice(0, 4)) <= 22
    )
    const partialMigrationsDir = join(dir, 'partial-migrations')
    mkdirSync(join(partialMigrationsDir, 'meta'), { recursive: true })
    for (const entry of entriesThrough0022) {
      copyFileSync(
        join(REAL_MIGRATIONS_DIR, `${entry.tag}.sql`),
        join(partialMigrationsDir, `${entry.tag}.sql`)
      )
    }
    writeFileSync(
      join(partialMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: entriesThrough0022,
      })
    )
    migrate(db, { migrationsFolder: partialMigrationsDir })

    const organizationId = randomUUID()
    const projectId = randomUUID()
    const courseId = randomUUID()
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
          (id, organization_id, project_id, title, file_prefix, enabled, admins_role,
           students_role, conversation_scope, prompt_id, instructions, model,
           vector_store_id, max_requests_per_day, discord_server_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        'course',
        'prompt-1',
        'Be helpful.',
        'gpt-4o',
        'vs-1',
        50,
        null,
        now
      )

    // The migration under test: 0023, applied through the real migrations
    // folder — this must not throw.
    expect(() => runMigrations(db as Database)).not.toThrow()

    const columns = db.$client.prepare('pragma table_info(courses)').all() as {
      name: string
    }[]
    expect(columns.map((c) => c.name)).not.toContain('file_prefix')

    // Every sibling column on that same row survived the drop unchanged —
    // not merely present, but still carrying the value it went in with.
    const course = db.$client
      .prepare('select * from courses where id = ?')
      .get(courseId)
    expect(course).not.toHaveProperty('file_prefix')
    expect(course).toMatchObject({
      id: courseId,
      organization_id: organizationId,
      project_id: projectId,
      title: 'Web Design',
      enabled: 1,
      admins_role: 'admins-wd',
      students_role: 'students-wd',
      conversation_scope: 'course',
      prompt_id: 'prompt-1',
      instructions: 'Be helpful.',
      model: 'gpt-4o',
      vector_store_id: 'vs-1',
      max_requests_per_day: 50,
      discord_server_id: null,
    })
  })

  // ENRL-13/ENRL-14 — the same "seed what a real deployment already has,
  // then apply the real migration on top" shape the 0023 test above uses:
  // `self_enrol_from_discord`/`answer_unenrolled` are added by 0025 onto a
  // `courses` table that may already hold rows, and every one of them has
  // to come back reading as today's behaviour — `false`/`true` — not `null`
  // or a failed migration. Fails without the database-level `DEFAULT` on
  // each column (`schema.ts`'s own comment on why): a plain, undefaulted
  // `ADD COLUMN NOT NULL` refuses outright the moment a table already has a
  // row, the same class of defect the 0013 test elsewhere in this file
  // pins for a different column.
  it('applies 0025 to a database that already has a course, defaulting selfEnrolFromDiscord to false and answerUnenrolled to true', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    const journal = JSON.parse(
      readFileSync(join(REAL_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] }
    const entriesThrough0024 = journal.entries.filter(
      (entry) => Number(entry.tag.slice(0, 4)) <= 24
    )
    const partialMigrationsDir = join(dir, 'partial-migrations')
    mkdirSync(join(partialMigrationsDir, 'meta'), { recursive: true })
    for (const entry of entriesThrough0024) {
      copyFileSync(
        join(REAL_MIGRATIONS_DIR, `${entry.tag}.sql`),
        join(partialMigrationsDir, `${entry.tag}.sql`)
      )
    }
    writeFileSync(
      join(partialMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: entriesThrough0024,
      })
    )
    migrate(db, { migrationsFolder: partialMigrationsDir })

    const organizationId = randomUUID()
    const projectId = randomUUID()
    const courseId = randomUUID()
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
    // No `self_enrol_from_discord`/`answer_unenrolled` column exists yet at
    // this point — this is the pre-0025 shape a real deployment's `courses`
    // table already has.
    db.$client
      .prepare(
        `insert into courses
          (id, organization_id, project_id, title, enabled, admins_role,
           students_role, conversation_scope, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        courseId,
        organizationId,
        projectId,
        'Web Design',
        1,
        'admins-wd',
        'students-wd',
        'course',
        now
      )

    // The migration under test: 0025, applied through the real migrations
    // folder — this must not throw.
    expect(() => runMigrations(db as Database)).not.toThrow()

    const course = db.$client
      .prepare('select * from courses where id = ?')
      .get(courseId)
    expect(course).toMatchObject({
      id: courseId,
      self_enrol_from_discord: 0,
      answer_unenrolled: 1,
    })
  })

  // PROJ-7: 0026 rebuilds `courses` itself (drizzle-kit's own SQLite
  // "rebuild the table" recipe for dropping `admins_role`/`students_role`'s
  // `NOT NULL`) — the one migration in this file whose own `INSERT ...
  // SELECT` could plausibly drop a column or lose a child row on the way
  // through `__new_courses`. Seeded with every column populated (not an
  // empty course, which would pass by accident) plus a `course_categories`
  // child row, so a lost value or an orphaned child both have something to
  // show up against.
  it('applies 0026 to a database that already has a fully-populated course and a category, preserving both through the __new_courses rebuild', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    const journal = JSON.parse(
      readFileSync(join(REAL_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] }
    const entriesThrough0025 = journal.entries.filter(
      (entry) => Number(entry.tag.slice(0, 4)) <= 25
    )
    const partialMigrationsDir = join(dir, 'partial-migrations')
    mkdirSync(join(partialMigrationsDir, 'meta'), { recursive: true })
    for (const entry of entriesThrough0025) {
      copyFileSync(
        join(REAL_MIGRATIONS_DIR, `${entry.tag}.sql`),
        join(partialMigrationsDir, `${entry.tag}.sql`)
      )
    }
    writeFileSync(
      join(partialMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: entriesThrough0025,
      })
    )
    migrate(db, { migrationsFolder: partialMigrationsDir })

    const organizationId = randomUUID()
    const projectId = randomUUID()
    const courseId = randomUUID()
    const categoryId = randomUUID()
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
    // Every column the `__new_courses` rebuild's own `INSERT ... SELECT`
    // has to carry across.
    db.$client
      .prepare(
        `insert into courses
          (id, organization_id, project_id, title, enabled, admins_role,
           students_role, prompt_id, instructions, model, vector_store_id,
           max_requests_per_day, conversation_scope, discord_server_id,
           self_enrol_from_discord, answer_unenrolled, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        courseId,
        organizationId,
        projectId,
        'Web Design',
        1,
        'admins-wd-fa26',
        'students-wd-fa26',
        'prompt-abc',
        'Be helpful.',
        'gpt-5',
        'vs-abc',
        40,
        'course_surface',
        null,
        1,
        0,
        now
      )
    db.$client
      .prepare(
        'insert into course_categories (id, organization_id, course_id, name, ordering, created_at) values (?, ?, ?, ?, ?, ?)'
      )
      .run(categoryId, organizationId, courseId, 'Web Design - GLOBAL', 0, now)

    // The migration under test: 0026, applied through the real migrations
    // folder — this must not throw, including the new `foreign_key_check`
    // safety net (`migrate.ts`) run right after it.
    expect(() => runMigrations(db as Database)).not.toThrow()

    const course = db.$client
      .prepare('select * from courses where id = ?')
      .get(courseId)
    expect(course).toMatchObject({
      id: courseId,
      admins_role: 'admins-wd-fa26',
      students_role: 'students-wd-fa26',
      prompt_id: 'prompt-abc',
      instructions: 'Be helpful.',
      model: 'gpt-5',
      vector_store_id: 'vs-abc',
      max_requests_per_day: 40,
      conversation_scope: 'course_surface',
      self_enrol_from_discord: 1,
      answer_unenrolled: 0,
    })
    const category = db.$client
      .prepare('select * from course_categories where id = ?')
      .get(categoryId)
    expect(category).toMatchObject({ id: categoryId, course_id: courseId })
  })

  // The safety net `migrate.ts` restored (review round 1): disabling
  // `foreign_keys` for the whole batch (0026's own table rebuild needs it)
  // used to mean a migration that left an orphan behind — a bad backfill,
  // say — would commit silently, where before this file ever disabled
  // anything that same mistake failed loudly. `PRAGMA foreign_key_check`
  // now runs immediately afterward and refuses the whole batch if it finds
  // one, checked against the *entire* database, not only the table 0026
  // itself touches — which is exactly why this orphan can be seeded in
  // `course_categories`, a table 0026 never rebuilds, and still be caught.
  it('refuses a migration batch that would leave a foreign-key violation behind, even one that predates the batch', () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))

    const journal = JSON.parse(
      readFileSync(join(REAL_MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; tag: string }[] }
    const entriesThrough0025 = journal.entries.filter(
      (entry) => Number(entry.tag.slice(0, 4)) <= 25
    )
    const partialMigrationsDir = join(dir, 'partial-migrations')
    mkdirSync(join(partialMigrationsDir, 'meta'), { recursive: true })
    for (const entry of entriesThrough0025) {
      copyFileSync(
        join(REAL_MIGRATIONS_DIR, `${entry.tag}.sql`),
        join(partialMigrationsDir, `${entry.tag}.sql`)
      )
    }
    writeFileSync(
      join(partialMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: entriesThrough0025,
      })
    )
    migrate(db, { migrationsFolder: partialMigrationsDir })

    const organizationId = randomUUID()
    const now = Date.now()
    db.$client
      .prepare(
        'insert into organizations (id, name, is_personal, created_at) values (?, ?, ?, ?)'
      )
      .run(organizationId, 'Org A', 0, now)

    // An orphan `course_categories` row — naming a course that does not
    // exist — the shape a bad backfill migration could commit silently
    // while `foreign_keys` is off. `PRAGMA foreign_keys=OFF` here, briefly,
    // is only what lets this test insert the bad row at all (the
    // connection otherwise enforces it on every write, `client.ts`'s own
    // comment) — it does not simulate 0026 itself, which never writes to
    // this table.
    db.$client.pragma('foreign_keys = OFF')
    db.$client
      .prepare(
        'insert into course_categories (id, organization_id, course_id, name, ordering, created_at) values (?, ?, ?, ?, ?, ?)'
      )
      .run(
        randomUUID(),
        organizationId,
        'course-that-does-not-exist',
        'Orphan Category',
        0,
        now
      )
    db.$client.pragma('foreign_keys = ON')

    // The migration under test: 0026 — must now refuse rather than commit
    // silently alongside an orphan it never even touches.
    expect(() => runMigrations(db as Database)).toThrow(/foreign_key_check/)
  })
})

// ENRL-10 — 0017 adds `membership_invitations`, a brand-new table rather than
// a rebuild, so its columns are already pinned by the plain schema-shape
// assertion above (`schema.membership_invitations`, part of the first `it`
// in this file). What that assertion cannot see is *behaviour* the table's
// own `CHECK` and unique index are responsible for — the same class of gap
// 0015/0016's own test (above) exists to close for `jobs`.
describe('0017 — membership_invitations', () => {
  it("rejects a role outside ('owner', 'instructor', 'assistant'), and a duplicate secret hash", () => {
    dir = mkdtempSync(join(tmpdir(), 'bloombot-db-migrate-'))
    db = openDatabase(join(dir, 'test.db'))
    runMigrations(db)

    const organizationId = randomUUID()
    const accountId = randomUUID()
    const now = Date.now()
    db.$client
      .prepare(
        'insert into organizations (id, name, is_personal, created_at) values (?, ?, ?, ?)'
      )
      .run(organizationId, 'Org A', 0, now)
    db.$client
      .prepare(
        'insert into accounts (id, email, display_name, created_at) values (?, ?, ?, ?)'
      )
      .run(accountId, 'owner@example.edu', 'Owner', now)

    const insertInvitation = db.$client.prepare(
      `insert into membership_invitations
        (id, organization_id, email, role, secret_hash, created_by_account_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    )

    // The CHECK constraint, belt-and-suspenders on top of the TypeScript
    // `enum` — a value no repo function in this package would ever write,
    // but the constraint's own job is refusing it regardless of who wrote
    // it (`schema.ts`'s own comment on `membership_invitations_role_check`).
    expect(() =>
      insertInvitation.run(
        randomUUID(),
        organizationId,
        'invitee@example.edu',
        'not-a-real-role',
        'hash-1',
        accountId,
        now
      )
    ).toThrow(/CHECK constraint failed/)

    // The unique index on `secret_hash` — two invitations must never be
    // redeemable by the same secret, the same guarantee
    // `course_join_links_secret_hash_unique` already gives ENRL-3/4.
    insertInvitation.run(
      randomUUID(),
      organizationId,
      'a@example.edu',
      'instructor',
      'hash-shared',
      accountId,
      now
    )
    expect(() =>
      insertInvitation.run(
        randomUUID(),
        organizationId,
        'b@example.edu',
        'assistant',
        'hash-shared',
        accountId,
        now
      )
    ).toThrow(/UNIQUE constraint failed/)
  })
})
