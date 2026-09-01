/**
 * The tenancy tables every later slice hangs off (TEN-1, TEN-2, TEN-3).
 *
 * Held to the portable subset D-2 requires: plain `text`/`integer` columns, no
 * SQLite-only column types, and `CHECK`/`ON CONFLICT DO UPDATE ... WHERE` — both
 * standard SQL, supported by Postgres too — rather than anything SQLite-specific.
 * SQLite-only idioms belong in `migrations/`, never here.
 *
 * Ids are application-generated UUIDs (`crypto.randomUUID()`, in `src/repos/`),
 * not `AUTOINCREMENT`: an auto-incrementing integer key is a SQLite/Postgres
 * detail a portable schema should not depend on, and a client-generated id lets
 * a repo function return the id of a row it has not read back yet.
 *
 * Timestamps are epoch milliseconds stored as `INTEGER`, set by the repo layer
 * with `Date.now()` rather than a SQL default — `CURRENT_TIMESTAMP` differs
 * between SQLite (seconds, as text) and Postgres (a timestamp type), so a SQL
 * default would be one more thing to rewrite when the engine changes.
 */

import { sql } from 'drizzle-orm'
import {
  check,
  primaryKey,
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// TEN-1 — the tenant is an organization. An account gets a personal
// organization on sign-up (`is_personal`); every other scoped table carries
// this id.
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isPersonal: integer('is_personal', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at').notNull(),
})

// An account is a person's sign-in identity. It is deliberately *not*
// organization-scoped — the same account can belong to more than one
// organization through `memberships` — which is why `getAccountByEmail` (in
// `repos/accounts.ts`) is one of the two documented TEN-2 exceptions: an
// account has to be found before any organization is known at all.
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  // Stored lowercased by the repo layer (`repos/accounts.ts`) so `email`
  // uniqueness cannot be bypassed by case alone.
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  // Set to disable sign-in without deleting the account or anything it owns.
  disabledAt: integer('disabled_at'),
  createdAt: integer('created_at').notNull(),
})

// The roles a membership can hold. A single source for the TypeScript `enum`
// column below and the `CHECK` constraint that backs it, so the two can never
// drift apart.
export const MEMBERSHIP_ROLES = ['owner', 'instructor', 'assistant'] as const
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

// TEN-1 — membership is a separate record from the account, so a second
// instructor or a teaching assistant can be added to an organization without
// restructuring anything. The composite primary key is what makes "is this
// account in this organization" a single indexed lookup.
export const memberships = sqliteTable(
  'memberships',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.accountId] }),
    // Belt-and-suspenders on top of the TypeScript `enum` above: `enum` narrows
    // the type this package writes, but does nothing to a row written by a
    // future direct SQL statement or a different process. The CHECK is what
    // actually stops a bad value reaching the table.
    check(
      'memberships_role_check',
      sql`${table.role} in ('owner', 'instructor', 'assistant')`
    ),
  ]
)

// TEN-3 — one organization per Discord server, enforced structurally: the
// snowflake is the primary key, so a second `INSERT` for an already-bound
// server fails at the database level rather than relying on an application
// check that a future call site could forget. TEN-6 — removal never deletes
// the row, it sets `removed_at`, which is also what lets the same snowflake
// be re-claimed later (`repos/discord-servers.ts`).
export const discordServerBindings = sqliteTable('discord_server_bindings', {
  // The Discord guild (server) snowflake. Snowflakes exceed
  // `Number.MAX_SAFE_INTEGER`, so this is text, not integer, to avoid
  // precision loss — and text is what makes it usable as a primary key
  // Postgres can mirror with the same type.
  serverId: text('server_id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  installedByAccountId: text('installed_by_account_id')
    .notNull()
    .references(() => accounts.id),
  installedAt: integer('installed_at').notNull(),
  removedAt: integer('removed_at'),
})

// PROJ-1 — course configurations are grouped into a project, typically a
// term (e.g. "Fall 2026"), replacing the convention of encoding the term
// into Discord role names. PROJ-2 — archiving a project stops its courses
// routing without deleting anything; `archivedAt` is nullable and
// reversible, the same shape `discordServerBindings.removedAt` above uses
// for TEN-6.
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    // A project name is unique within an organization, but only among
    // projects that are *not* archived: once a term is archived, its name is
    // free for a new project to reuse (PROJ-2). Enforced structurally with a
    // partial unique index — the same "let the database refuse it rather
    // than trust an application check" approach `discordServerBindings`
    // takes for TEN-3 — and a partial unique index is portable SQL Postgres
    // supports too (D-2), so this does not become a rewrite later.
    uniqueIndex('projects_org_name_active_unique')
      .on(table.organizationId, table.name)
      .where(sql`${table.archivedAt} is null`),
  ]
)

// PROJ-1 — one course configuration. This is the database form of a
// `server.courses` entry in `bot_config.yml` (CFG-1 … CFG-4): the columns
// below are that YAML shape carried into a row, not a redesign of it, so a
// later slice can import a course unchanged.
export const courses = sqliteTable('courses', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  title: text('title').notNull(),
  // CFG-1 — the prefix used to locate this course's roster and
  // questionnaire CSV files.
  filePrefix: text('file_prefix').notNull(),
  // A disabled course routes nothing — the database equivalent of
  // commenting a course out of `bot_config.yml` (CFG-1) — and is excluded
  // from the PROJ-3 name-collision check below, the same way a course in an
  // archived project is.
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  // CFG-3 — the two Discord role names this course is taught through.
  // PROJ-3 requires these unique across every *enabled* course in the
  // organization; that check is conditional on other tables (which project
  // a course belongs to, whether it is archived) and needs to name the
  // conflicting course and project in its refusal, so it is enforced in
  // `repos/courses.ts`, not with a SQL constraint here — see that file.
  adminsRole: text('admins_role').notNull(),
  studentsRole: text('students_role').notNull(),
  // CFG-2 / D-3 — answering settings. All nullable, and nullable means "not
  // configured, fall back to the platform default": no default value is
  // invented here, the same reasoning D-10 already applied to the YAML
  // schema this table mirrors. `promptId` is D-3's escape hatch — when set
  // it wins over `instructions`.
  promptId: text('prompt_id'),
  instructions: text('instructions'),
  model: text('model'),
  vectorStoreId: text('vector_store_id'),
  maxRequestsPerDay: integer('max_requests_per_day'),
  createdAt: integer('created_at').notNull(),
})

// CFG-4 — a Discord category belonging to a course. `ordering` is the
// position categories are declared in — the YAML list's order today — kept
// explicit here since a database table otherwise has no inherent order.
export const courseCategories = sqliteTable('course_categories', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  courseId: text('course_id')
    .notNull()
    .references(() => courses.id),
  name: text('name').notNull(),
  ordering: integer('ordering').notNull(),
  createdAt: integer('created_at').notNull(),
})

// CFG-4 — a channel inside a category. `adminsOnly` mirrors the YAML's
// `admins_only` flag; `ordering` is the channel list's declared order,
// carried the same way `courseCategories.ordering` carries the category
// list's.
export const courseChannels = sqliteTable('course_channels', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  categoryId: text('category_id')
    .notNull()
    .references(() => courseCategories.id),
  name: text('name').notNull(),
  adminsOnly: integer('admins_only', { mode: 'boolean' }).notNull(),
  ordering: integer('ordering').notNull(),
  createdAt: integer('created_at').notNull(),
})
