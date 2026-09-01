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
  index,
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

// CONV-1 — a course's conversation scope: `course` (the default) is one
// conversation per person per course across every surface; `course_surface`
// keeps each surface's conversation distinct, for instructors who want a web
// session kept separate from a Discord thread. Read by
// `repos/conversations.ts#getOrCreateConversation`, which is the only place
// this column is interpreted — see `conversations` below.
export const CONVERSATION_SCOPES = ['course', 'course_surface'] as const
export type ConversationScope = (typeof CONVERSATION_SCOPES)[number]

// PROJ-1 — one course configuration. This is the database form of a
// `server.courses` entry in `bot_config.yml` (CFG-1 … CFG-4): the columns
// below are that YAML shape carried into a row, not a redesign of it, so a
// later slice can import a course unchanged.
export const courses = sqliteTable(
  'courses',
  {
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
    // CONV-1 / D-4 — see `CONVERSATION_SCOPES` above. Defaulted at the
    // database level (unlike every other column here) because it is added
    // by a later migration onto a table that may already hold rows, and
    // every one of them means "the default behaviour", not "unset".
    conversationScope: text('conversation_scope', {
      enum: CONVERSATION_SCOPES,
    })
      .notNull()
      .default('course'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    check(
      'courses_conversation_scope_check',
      sql`${table.conversationScope} in ('course', 'course_surface')`
    ),
  ]
)

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

// PPL-2 / CONV-1 / CONV-2 — the surfaces a person can be reached through, or
// a conversation or message can have occurred on. One source for the
// TypeScript `enum` columns below and the `CHECK` constraints that back
// them, the same reasoning `MEMBERSHIP_ROLES` already applies.
export const SURFACES = ['discord', 'web', 'mcp'] as const
export type Surface = (typeof SURFACES)[number]

// PPL-1 — a person is the human a course serves, distinct from the account
// that signs in to administer a tenant (`accounts`, above). Every field but
// the id, organization and `createdAt` is nullable: PPL-3 creates a person
// with none of them set, on the first message from an identity nobody has
// seen, and they are filled in later — `firstName`/`lastName`/`email`/
// `githubHandle` when a roster is imported, `displayName` from whatever
// surface first names them — never invented here (D-10's "no default value
// is invented" reasoning applies the same way to "no roster data is
// invented").
export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  displayName: text('display_name'),
  email: text('email'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  githubHandle: text('github_handle'),
  createdAt: integer('created_at').notNull(),
})

// PPL-2 — a person is reached through identities, one per surface: a
// Discord snowflake, an email address, a web account id. Unique per
// (organization, surface, external id) so the same Discord account cannot
// resolve to two people in one organization — enforced structurally, the
// same "let the database refuse it" approach `projects`' partial unique
// index takes for PROJ-2, rather than trusted to an application check.
export const personIdentities = sqliteTable(
  'person_identities',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    surface: text('surface', { enum: SURFACES }).notNull(),
    externalId: text('external_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('person_identities_org_surface_external_unique').on(
      table.organizationId,
      table.surface,
      table.externalId
    ),
    check(
      'person_identities_surface_check',
      sql`${table.surface} in ('discord', 'web', 'mcp')`
    ),
  ]
)

// CONV-1 — the continuity of one person's exchange with one course, keyed on
// the course and the person rather than on the surface account it arrived
// through. `surface` is null when the owning course's `conversationScope`
// is `course` (the default: one conversation per person per course across
// every surface) and set to the arrival surface when it is `course_surface`
// (`repos/conversations.ts#getOrCreateConversation` is the only place that
// decides which). `upstreamThreadId` is nullable: the model thread this
// conversation resumes is only known once the first request to it is made.
//
// Structural uniqueness needs two partial indexes, not one plain unique
// index on `(organizationId, courseId, personId, surface)`: SQL treats every
// `NULL` in a unique index as distinct from every other `NULL` (standard
// behaviour, not a SQLite quirk — Postgres does the same), so a plain index
// would let an unbounded number of `course`-scoped (surface-`null`) rows
// through for the same person and course, exactly the case CONV-1 requires
// to be a single row. Splitting the constraint on `surface IS NULL` closes
// that: at most one `course`-scoped conversation per (organization, course,
// person), and at most one `course_surface`-scoped conversation per
// (organization, course, person, surface) — both partial unique indexes,
// portable SQL Postgres supports too (D-2), the same device `projects`' own
// `archivedAt IS NULL` index already uses for PROJ-2.
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    surface: text('surface', { enum: SURFACES }),
    upstreamThreadId: text('upstream_thread_id'),
    createdAt: integer('created_at').notNull(),
    lastMessageAt: integer('last_message_at').notNull(),
  },
  (table) => [
    uniqueIndex('conversations_org_course_person_unscoped_unique')
      .on(table.organizationId, table.courseId, table.personId)
      .where(sql`${table.surface} is null`),
    uniqueIndex('conversations_org_course_person_surface_unique')
      .on(table.organizationId, table.courseId, table.personId, table.surface)
      .where(sql`${table.surface} is not null`),
    check(
      'conversations_surface_check',
      sql`${table.surface} is null or ${table.surface} in ('discord', 'web', 'mcp')`
    ),
  ]
)

// CONV-2 — every message, in both directions. `personId` and `courseId` are
// carried alongside `conversationId` (denormalized, but always consistent
// with the conversation they belong to — `repos/conversations.ts#appendMessage`
// derives them from the conversation itself rather than trusting a caller's
// copy) so a query keyed on a person or a course, like the usage counters
// below, never has to join through `conversations` to reach them.
// `channelRef`/`categoryRef` are nullable: DATA-4's Discord `category` and
// `channel` context, present on Discord messages and absent on every other
// surface. Indexed by conversation (a transcript read) and by `createdAt`
// (the analytics notebook's other axis, DATA-4). There is no delete path
// for this table anywhere in this package (TEN-6): a transcript is a record
// an instructor may be required to retain.
export const MESSAGE_DIRECTIONS = ['from_person', 'to_person'] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id),
    direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
    content: text('content').notNull(),
    surface: text('surface', { enum: SURFACES }),
    channelRef: text('channel_ref'),
    categoryRef: text('category_ref'),
    // CONV-2 — `createdAt` alone does not order a transcript: it is
    // millisecond precision, `appendMessage` can be called for several
    // messages within the same millisecond, and SQL does not define an
    // order among rows tied on the `ORDER BY` column. `sequence` is a
    // monotonic counter assigned per conversation inside `appendMessage`'s
    // own transaction (`repos/conversations.ts`), so it is what
    // `getTranscript` actually orders by — `createdAt` stays for display and
    // for the DATA-4 analytics index below, not for ordering.
    sequence: integer('sequence').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('messages_conversation_id_idx').on(table.conversationId),
    index('messages_created_at_idx').on(table.createdAt),
    check(
      'messages_direction_check',
      sql`${table.direction} in ('from_person', 'to_person')`
    ),
    check(
      'messages_surface_check',
      sql`${table.surface} is null or ${table.surface} in ('discord', 'web', 'mcp')`
    ),
  ]
)

// CONV-3 — a person's daily allowance, counted per course per calendar day.
// `day` is an explicit `YYYY-MM-DD` string set by the repo layer from a
// caller-supplied value, never derived from `createdAt` when the row is
// read — that derivation-on-read is the exact defect BOT-11 fixed in the
// Python bot (a boundary check that trusted an in-memory counter's own idea
// of "today" instead of re-deriving it). The primary key is the same
// four-part composite the two partial unique indexes on `conversations`
// approximate with `NULL`-splitting, except every column here is always
// set, so a single composite primary key is enough — no partial index
// needed.
export const usageCounters = sqliteTable(
  'usage_counters',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id),
    personId: text('person_id')
      .notNull()
      .references(() => people.id),
    day: text('day').notNull(),
    count: integer('count').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.courseId,
        table.personId,
        table.day,
      ],
    }),
    // BOT-11's class of defect, closed a second way: `repos/usage.ts`
    // already refuses a `day` that is not `YYYY-MM-DD` before it ever
    // reaches SQL, but a `CHECK` is what stops a future direct writer that
    // skips the repo layer from creating a counter row under a malformed
    // day string — which `incrementUsage`'s `ON CONFLICT` target would then
    // never match again, silently bypassing `max_requests_per_day`. Written
    // with `length`/`substr`/`BETWEEN` rather than a SQLite-only `GLOB` or a
    // Postgres-only `~`, so it stays inside D-2's portable subset.
    check(
      'usage_counters_day_check',
      sql`length(${table.day}) = 10
        and substr(${table.day}, 1, 1) between '0' and '9'
        and substr(${table.day}, 2, 1) between '0' and '9'
        and substr(${table.day}, 3, 1) between '0' and '9'
        and substr(${table.day}, 4, 1) between '0' and '9'
        and substr(${table.day}, 5, 1) = '-'
        and substr(${table.day}, 6, 1) between '0' and '9'
        and substr(${table.day}, 7, 1) between '0' and '9'
        and substr(${table.day}, 8, 1) = '-'
        and substr(${table.day}, 9, 1) between '0' and '9'
        and substr(${table.day}, 10, 1) between '0' and '9'`
    ),
  ]
)

// AUTH-1 — a single-use, passwordless sign-in link. Keyed on the email
// address it was requested for, not an account id: the account a link
// resolves to may not exist yet (AUTH-1's "an account is created and
// accessed by a link" — a first-time sign-in creates it on redemption, see
// `@bloombot/auth`'s `sign-in.ts`), so there is nothing to scope this row to
// until the token is redeemed. Organization-independent for the same reason
// `accounts` itself is (TEN-1: an account exists before any organization
// does) — this table sits one step earlier still, before even the account.
// `tokenHash` only: the plaintext value is generated and returned to the
// caller exactly once, by `@bloombot/auth`'s `tokens.ts`, and is never
// written to this table (AUTH-1's "stored as hashes"). `usedAt` is the
// single-use marker; `repos/sign-in-tokens.ts#consumeSignInToken` sets it
// with one conditional `UPDATE` rather than a `SELECT` then an `UPDATE`, so
// two concurrent redemptions of the same token cannot both succeed — the
// same reasoning `discordServerBindings`' re-claim guard documents for
// TEN-3.
export const signInTokens = sqliteTable(
  'sign_in_tokens',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('sign_in_tokens_email_idx').on(table.email)]
)

// AUTH-3 — an opaque, revocable session. Keyed on the account, not an
// organization: a session authenticates a person across every organization
// their account belongs to (which organization is acting is a separate,
// per-request concern the API layer resolves), the same account-not-org
// scoping `accounts` itself uses. `tokenHash` only, never the token itself —
// this is *why* hashes are stored rather than tokens at all: administrative
// revocation (single session, or every session of an account) only needs to
// find and mark rows, never to recover a secret a stolen database row could
// then replay (SPEC.md AUTH-3). `lastSeenAt` is touched on every successful
// validation; `revokedAt` is nullable and covers both a single-session
// revoke and a rotate-on-sign-in (the old row is revoked, a new one
// created) — see `@bloombot/auth`'s `sessions.ts`.
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [index('sessions_account_id_idx').on(table.accountId)]
)

// TEN-4 — the Discord install flow's server-side OAuth+PKCE state: one row
// per installation attempt, from a signed-in caller beginning it
// (`@bloombot/auth`'s `discord-install.ts#beginDiscordInstall`) to the
// callback redeeming it exactly once. `stateHash` is looked up the same way
// `sign_in_tokens.token_hash` is — the plaintext `state` value is generated
// and returned to the caller exactly once, and never written here. Unlike
// every other secret in this schema, `codeVerifier` is stored in plain
// text: PKCE's verifier is not a bearer credential a caller ever presents
// back to us to prove anything, it is a value this server generated for
// itself and must hand to Discord's token endpoint, verbatim, to complete
// the exchange — hashing it would make it unusable rather than safer. See
// docs/DECISIONS.md D-21. `usedAt` is the single-use marker, the same
// device `signInTokens` uses; `organizationId`/`accountId` are what the
// callback claims the eventual binding for and records as its installer,
// carried forward from whichever signed-in session began the attempt.
export const discordInstallStates = sqliteTable(
  'discord_install_states',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    stateHash: text('state_hash').notNull().unique(),
    codeVerifier: text('code_verifier').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('discord_install_states_account_id_idx').on(table.accountId),
  ]
)
