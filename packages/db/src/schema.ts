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
