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
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'

// TEN-1 — the tenant is an organization. An account gets a personal
// organization on sign-up (`is_personal`); every other scoped table carries
// this id.
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isPersonal: integer('is_personal', { mode: 'boolean' }).notNull(),
  // COST-3 — the total the organization may spend before `answerQuestion`
  // (`@bloombot/core`'s `answer.ts`) refuses to ask the model at all. `null`
  // is "no cap configured", the same "no default value is invented"
  // reasoning `courses.maxRequestsPerDay`'s own comment already applies —
  // an organization with no cap set is never silently capped at some
  // platform-wide number. Integer micros, the same unit
  // `cost_ledger_entries.cost_micros` below uses, for the same reason (D-2's
  // own "money as INTEGER micros" rule): comparing a float cap against a
  // float running total is exactly how a ledger stops adding up.
  spendingCapMicros: integer('spending_cap_micros'),
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
    // ENRL-5 — who granted this role, and when. Null for the one membership
    // nobody grants: the founding owner row `accounts.createAccount` writes
    // atomically with a brand-new account (TEN-1) — a person cannot grant
    // themselves the very membership that first gives them anything to act
    // with, so that row has no grantor and is not created through
    // `repos/memberships.ts#grantMembershipRole` at all. Every other
    // membership — a second instructor added later, a role changed later —
    // goes through `grantMembershipRole`, which always stamps both columns:
    // "granted only by an existing owner, through an action that is
    // recorded" (ENRL-5) is this pair of columns, not a separate audit log,
    // the same "record it on the row itself" shape
    // `course_instruction_revisions.savedByAccountId` already uses for FILE-4.
    grantedByAccountId: text('granted_by_account_id').references(
      () => accounts.id
    ),
    grantedAt: integer('granted_at'),
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
// LINK-1/LINK-4 — `connectedAt` is the platform's own record of "this
// identity is attributed to a connected account" (LINK-1's own phrase): null
// for a person PPL-3 created on first sight and never proven since,
// non-null from the moment a proof first attaches an identity to this
// person, whether that attaches directly (`repos/people.ts#connectIdentity`)
// or merges two records (`#mergePeople`) — both go through `#markConnected`
// (LINK-3's proof, LINK-4's merge) — set
// once and never moved backward on a later merge (`mergePeople`'s own
// comment), so it always reads as "when this person first connected", not
// "when they were last merged". `mergedIntoPersonId`/`mergedAt` are the
// other half of LINK-4's "recorded, because it rewrites who owns a
// transcript": a person who has been merged away is never deleted (the same
// never-delete discipline `discordServerBindings.removedAt` already holds
// itself to) — its row, and everything still keyed on its old id that a
// merge deliberately leaves in place (see `mergePeople`'s own comment), stay
// exactly where they were, with `mergedIntoPersonId` naming who to read
// instead. Both are nullable and self-referencing, so a fresh person (the
// ordinary case) carries neither.
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
  connectedAt: integer('connected_at'),
  mergedIntoPersonId: text('merged_into_person_id').references(
    (): AnySQLiteColumn => people.id
  ),
  mergedAt: integer('merged_at'),
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

// JOB-1..3 — the background queue: anything that cannot finish inside a
// request (provisioning a server's channels, importing a roster, attaching a
// knowledge file, duplicating a term) is a row here rather than work held
// open on an HTTP connection. `organizationId` is carried on every job, the
// same TEN-1 discipline every other scoped table holds itself to — JOB-1's
// own text is explicit that a queue must not be a way around it. `kind` and
// `payload` are deliberately opaque to this table: `kind` selects a handler
// a caller registered (`packages/jobs`), and `payload` is that handler's own
// JSON, not a shape this schema tries to model — a handler that reads a
// foreign id out of its own payload still reaches it only through
// `repos/**`'s usual organization-scoped functions, so a payload naming
// another tenant's record is refused the same way any other cross-tenant
// read or write is (`repos/jobs.ts`'s own module comment has the worked
// example).
export const JOB_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    // How many attempts this job has been claimed for, incremented by
    // `repos/jobs.ts#claimNextJob` at the moment of claim — attempt 1 is the
    // first run, not the first retry (JOB-2).
    attempts: integer('attempts').notNull(),
    // JOB-2's bound. Set once, from the caller's retry policy, when the job
    // is enqueued — not read from a platform default here, the same "no
    // default value is invented" reasoning `courses.maxRequestsPerDay`'s own
    // comment already applies to a column like this.
    maxAttempts: integer('max_attempts').notNull(),
    // When this job next becomes claimable: the enqueue time on a fresh job,
    // or `now + backoff` after a retryable failure (JOB-2) — always an
    // explicit value the repo layer sets, never derived from a clock read
    // inside a query, the same BOT-11 discipline `usage_counters.day`'s own
    // comment holds itself to.
    nextAttemptAt: integer('next_attempt_at').notNull(),
    // JOB-3's lease: who currently holds this job (an opaque worker-instance
    // id) and until when. Both null when the job is not currently claimed —
    // pending, succeeded, or failed. A claim whose `claimExpiresAt` has
    // passed is treated as released, so a worker that dies mid-job does not
    // strand it (see `repos/jobs.ts#claimNextJob`).
    claimedBy: text('claimed_by'),
    claimExpiresAt: integer('claim_expires_at'),
    // The most recent failure's reason, kept even once a job reaches its
    // terminal `failed` status — JOB-2's "stays visible with the reason it
    // stopped, rather than disappearing". Also set (without a status change)
    // on a retryable failure, so the row shows why the *last* attempt failed
    // while it waits for the next one.
    lastError: text('last_error'),
    // SRV-6..8 — what a succeeded handler resolved with, JSON, opaque to
    // this table the same way `payload` above is (this file's own module
    // comment): `repos/jobs.ts#completeJob`'s own optional `result` argument
    // sets this, `@bloombot/jobs`'s `runNextJob` passes through whatever the
    // handler's promise resolved to, and `@bloombot/actions`'s `jobs.get`
    // read action is what a caller (the panel, eventually) reads it back
    // through. Null until a job succeeds — a job still running, still
    // pending, or that failed instead, has no report to show.
    result: text('result'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    // The shape `claimNextJob`'s own candidate lookup filters and orders
    // by (`repos/jobs.ts`) — an eligible job is always found by `status`
    // first, then ordered by `nextAttemptAt`.
    index('jobs_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('jobs_organization_id_idx').on(table.organizationId),
    check(
      'jobs_status_check',
      sql`${table.status} in ('pending', 'running', 'succeeded', 'failed')`
    ),
  ]
)

// FILE-1..5 — the knowledge files an instructor attaches to a course, and
// FILE-2's own visible lifecycle for one: `pending` from the moment the
// bytes land on disk and the job that will upload them is enqueued,
// `ready` once `apps/worker`'s handler has uploaded the bytes to the
// provider and attached them to the course's vector store, or `failed`
// (with `failureReason`, the provider's own message) when the provider
// rejects the file — a course must never look configured while an
// attachment sits `failed` (FILE-2's own text), which is exactly why this
// is a status a caller reads rather than something inferred from
// `providerFileId` being null.
export const ATTACHMENT_STATUSES = ['pending', 'ready', 'failed'] as const
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number]

export const courseAttachments = sqliteTable(
  'course_attachments',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id),
    // A display value only (FILE-5) — never part of the path the bytes are
    // actually written under (`attachment-storage.ts`'s own module
    // comment), so nothing about what an instructor's browser calls the
    // file can influence where it lands on disk.
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: ATTACHMENT_STATUSES }).notNull(),
    // Set once the provider has uploaded the file and reported its own id
    // back (FILE-1) — null until then. Recorded as soon as the upload
    // itself succeeds (`repos/course-attachments.ts#recordProviderFileId`,
    // a rework finding), *before* the file is attached to a vector store —
    // so a `failed` attachment still carries it whenever the upload itself
    // succeeded, and `courseAttachments.detach` can still reach the
    // provider to remove it rather than stranding it there permanently.
    providerFileId: text('provider_file_id'),
    // The provider's own rejection message (FILE-2) — null unless
    // `status = 'failed'`.
    failureReason: text('failure_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('course_attachments_course_id_idx').on(table.courseId),
    index('course_attachments_organization_id_idx').on(table.organizationId),
    check(
      'course_attachments_status_check',
      sql`${table.status} in ('pending', 'ready', 'failed')`
    ),
  ]
)

// FILE-4 / D-3 — every save of a course's instructions is kept, not just the
// current one, so an instructor can see what the assistant was told last
// week and restore it. `courses.instructions` (above) is always the
// *current* text an answer is built from (D-3); this table is purely a
// history of how it got there — restoring an earlier revision (FILE-4)
// updates `courses.instructions` and adds a *new* row here recording the
// restore, rather than deleting or rewriting anything: "restore" is never
// destructive, the same "never delete" discipline SRV-8 already holds
// scaffolding to.
export const courseInstructionRevisions = sqliteTable(
  'course_instruction_revisions',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id),
    instructions: text('instructions').notNull(),
    // The account that saved this revision (FILE-4) — never null: every
    // revision, including one created by a restore, has an author.
    savedByAccountId: text('saved_by_account_id')
      .notNull()
      .references(() => accounts.id),
    // A real tiebreaker for `listRevisionsForCourse`'s "newest first" order
    // — the same reason `messages.sequence` exists (that column's own
    // comment): `createdAt` is millisecond precision, two saves can land in
    // the same millisecond, and SQL defines no order among rows tied on the
    // `ORDER BY` column. One more than the highest `sequence` already
    // recorded for this course, assigned in the same transaction as the
    // insert (`repos/course-instruction-revisions.ts#createRevision`).
    sequence: integer('sequence').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('course_instruction_revisions_course_id_idx').on(table.courseId),
    index('course_instruction_revisions_organization_id_idx').on(
      table.organizationId
    ),
  ]
)

// COST-1/COST-6 — a call's cost is either `measured` (the provider reported
// token counts, `repos/cost-ledger.ts#recordCostLedgerEntry` priced them
// against a configured rate) or `estimated` — either because the provider
// reported no usage at all (`@bloombot/openai`'s own `extractUsage` returns
// `undefined` rather than inventing zeros, MDL-5), or because the model it
// billed for has no configured rate (`@bloombot/config`'s pricing table
// falls back to a documented default rate rather than pricing it at zero).
// One column, not a boolean, so a future third case (a provider that reports
// *partial* usage, say) has somewhere to go without a schema rewrite.
export const COST_MEASUREMENTS = ['measured', 'estimated'] as const
export type CostMeasurement = (typeof COST_MEASUREMENTS)[number]

// COST-1/COST-2 — one row per model call, attributed to the organization,
// course and person it was made for. `organizationId`, `courseId` and
// `personId` are all `.notNull()` — COST-2's "a call that cannot be
// attributed is a defect, not a row with a null" is enforced structurally
// here, the same "let the database refuse it" approach `discordServerBindings`
// takes for TEN-3, rather than trusted to an application check alone:
// nothing can construct a row with any of the three missing, not even a
// future direct writer that skips `repos/cost-ledger.ts` entirely.
// `inputTokens`/`outputTokens` are nullable, for a caller with genuinely
// nothing to report — `0` would read as a fact ("this call used zero
// tokens") rather than what it actually is. In practice
// `@bloombot/core`'s own `computeCost` (finding 2 of the COST-1 rework)
// fills both even when the provider reported no usage at all, from a
// character-based estimate of the request and answer text, rather than
// leaving them `null` while `costMicros` is priced from them anyway —
// `measurement` (below), not nullness, is what tells a reader the count is
// an estimate rather than what the provider actually reported. `costMicros`
// is always set, integer micros (D-2), never a float — a ledger a float can
// silently drift is not a ledger.
export const costLedgerEntries = sqliteTable(
  'cost_ledger_entries',
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
    model: text('model').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costMicros: integer('cost_micros').notNull(),
    measurement: text('measurement', { enum: COST_MEASUREMENTS }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    // COST-3's cap check sums every row for an organization; COST-4's
    // instructor read sums by course within it — both index the columns
    // they filter by, the same "index what a real query filters by" pattern
    // `messages`/`course_attachments` already follow above.
    index('cost_ledger_entries_organization_id_idx').on(table.organizationId),
    index('cost_ledger_entries_course_id_idx').on(table.courseId),
    check(
      'cost_ledger_entries_measurement_check',
      sql`${table.measurement} in ('measured', 'estimated')`
    ),
  ]
)

// ENRL-1..3 — which courses a person may ask, a stored relation rather than
// something inferred per message (ENRL-1). `source` is which of the three
// admission decisions created the row — ENRL-3's "the platform records
// which of the three admitted them" — and, structurally, is the only fact
// `repos/enrolments.ts` lets a caller assert about a new row at all: that
// file exports no function that takes an arbitrary `source`, only three
// that each write their own literal (`enrolViaJoinLink`/`enrolViaDiscordRole`/
// `enrolViaRoster`), so "a person never enrols themselves out of nothing"
// is a fact about which functions exist, not a convention a caller has to
// remember.
export const ENROLMENT_SOURCES = [
  'join_link',
  'discord_role',
  'roster',
] as const
export type EnrolmentSource = (typeof ENROLMENT_SOURCES)[number]

// ENRL-6 — ending an enrolment stops the person asking; it deletes neither
// the row nor anything it touched. `endedAt` is nullable and reversible,
// the same "let the database refuse it, never delete it" shape
// `discordServerBindings.removedAt`/`projects.archivedAt` already use for
// TEN-6/PROJ-2 — "currently active" means `endedAt is null`, read that way
// everywhere in `repos/enrolments.ts` rather than a separate boolean this
// column would only ever duplicate.
export const enrolments = sqliteTable(
  'enrolments',
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
    source: text('source', { enum: ENROLMENT_SOURCES }).notNull(),
    createdAt: integer('created_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (table) => [
    // At most one *active* enrolment per (organization, course, person) —
    // enforced structurally, the same partial-unique-index approach
    // `conversations`' own pair of indexes uses above, rather than trusted
    // to an application check: redeeming the same join link twice, or
    // re-importing the same roster row, admits the same person into the
    // same course at most once at a time. A person may hold more than one
    // *ended* row for the same course (re-enrolled after leaving), which is
    // exactly why this index is partial rather than plain.
    uniqueIndex('enrolments_org_course_person_active_unique')
      .on(table.organizationId, table.courseId, table.personId)
      .where(sql`${table.endedAt} is null`),
    index('enrolments_organization_id_idx').on(table.organizationId),
    // Cheap-fix 10: `repos/enrolments.ts#listCoursesForPerson` (ENRL-2) and
    // `#getActiveEnrolment`/`#admit` all filter by `personId` alongside
    // `organizationId`, but the unique index above has `courseId` between
    // them — a query that does not also filter on `courseId` (`listCoursesForPerson`
    // does not) cannot use it past the leading `organizationId` column, so
    // it scanned every enrolment row in the tenant. `personId` first here
    // (rather than appended after `organizationId`) is what actually serves
    // that query without also filtering by course.
    index('enrolments_person_id_idx').on(table.personId, table.organizationId),
    check(
      'enrolments_source_check',
      sql`${table.source} in ('join_link', 'discord_role', 'roster')`
    ),
  ]
)

// ENRL-3/ENRL-4 — a course join link: an instructor-issued admission
// decision a student redeems. `secretHash` only, never the plaintext value —
// the same "returned once, stored only as a hash" shape `sign_in_tokens`
// already uses (AUTH-1), for the same reason: a claim link is a bearer
// secret, and a stolen database row must not be able to replay it.
// `revokedAt` is nullable and never un-set — ENRL-4's "revoking does not
// un-enrol anybody" is a fact about `repos/enrolments.ts` (it never reads
// this table at all), not something this column has to express by itself;
// this column's own job is only "does this link currently admit anyone
// new", read as `revokedAt is null and (expiresAt is null or expiresAt >
// now)` everywhere `repos/course-join-links.ts` checks it.
export const courseJoinLinks = sqliteTable('course_join_links', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  courseId: text('course_id')
    .notNull()
    .references(() => courses.id),
  secretHash: text('secret_hash').notNull().unique(),
  // Nullable — a link with no expiry is valid until revoked, the same
  // "nullable means not configured" reading `courses.maxRequestsPerDay`'s
  // own comment gives a nullable column elsewhere in this schema.
  expiresAt: integer('expires_at'),
  revokedAt: integer('revoked_at'),
  createdByAccountId: text('created_by_account_id')
    .notNull()
    .references(() => accounts.id),
  createdAt: integer('created_at').notNull(),
})

// LINK-3 — the proof half of connecting a second surface: one row per
// attempt, from `@bloombot/auth#beginDiscordPersonLink`/`issueMcpPersonLinkToken`
// generating a secret (and, for Discord, a PKCE verifier — the same
// OAuth+PKCE shape `discordInstallStates` already uses for TEN-4, mirrored
// here rather than shared: that table's `accountId` anchors an
// *administrator* proving they run a server; this table anchors a person on
// one side of the proof, never an account) to the caller consuming it
// exactly once. `surface` distinguishes the two proof shapes LINK-3 names —
// `discord` (Discord's own OAuth, `codeVerifier` set) and `mcp` (a bearer
// token with nothing else to verify against, `codeVerifier` null) — one
// table rather than two, since both are otherwise the same "single-use,
// expiring, hashed" secret shape `sign_in_tokens` already is.
//
// D-35 rework, finding 3 — which side is bound at issue time is *not* the
// same for both surfaces, because what each surface actually proves is not
// the same thing. Discord's OAuth genuinely proves a snowflake once the
// callback runs, so at issue time only the survivor (`personId`, "the
// account being connected", D-28) is known — the identity is unknown until
// the proof itself comes back, and `completeDiscordPersonLink` additionally
// has to check whoever calls it *back* is the same caller who began it
// (this table alone cannot enforce that; see `@bloombot/auth`'s own doc
// comment on the finding). MCP has no sign-in of its own — LINK-3's "a
// single-use, expiring token delivered where only that caller can read it"
// is itself the proof of the *identity*, delivered to the unconnected MCP
// caller at issue time, before any survivor is known — so for `mcp` it is
// `identityExternalId` that is set at issue, and the survivor is supplied
// only at redemption, by the signed-in account completing it. Getting this
// backwards (binding the survivor at issue and trusting a caller-supplied
// identity at redemption, this table's own shape before the rework) is an
// account-takeover: whoever redeems the token gets to *assert* whatever
// identity they like, merging its real owner into a survivor of the
// redeemer's choosing. The `CHECK` below makes the two shapes structural,
// not merely a convention two functions have to remember: a `discord` row
// always has `personId` and never `identityExternalId`; an `mcp` row is the
// exact opposite.
//
// `secretHash` only, never the plaintext value — the same "returned once,
// stored only as a hash" reasoning `sign_in_tokens`/`discord_install_states`
// already give themselves. Structurally does not *bind* anything by itself
// (LINK-3's "an identity is never bound on a visit alone"): nothing in this
// table's own shape can attach an identity to a person — only
// `repos/people.ts#connectIdentity`/`mergePeople`, called after
// `consumeChallenge` here succeeds, does that; `peekChallenge` (same repo)
// is the read-only counterpart that lets a caller show what a challenge
// *would* connect without spending it, for the "the page names the account
// being connected and waits to be told to proceed" half of LINK-3 the
// connect screens (a later slice) will need.
export const LINK_PROOF_SURFACES = ['discord', 'mcp'] as const
export type LinkProofSurface = (typeof LINK_PROOF_SURFACES)[number]

export const personLinkChallenges = sqliteTable(
  'person_link_challenges',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    // The survivor — set at issue for `discord`, null until redemption for
    // `mcp` (see this table's own module comment).
    personId: text('person_id').references(() => people.id),
    surface: text('surface', { enum: LINK_PROOF_SURFACES }).notNull(),
    // The identity being connected — null at issue for `discord` (unknown
    // until the OAuth callback), set at issue for `mcp` (this table's own
    // module comment). `surface` itself already says which surface this
    // external id belongs to; there is no separate `identitySurface`
    // column for the same reason `person_identities` needs no such thing
    // when it already has one row per (surface, external id).
    identityExternalId: text('identity_external_id'),
    secretHash: text('secret_hash').notNull().unique(),
    // Only set for `surface: 'discord'` — see `discordInstallStates.codeVerifier`'s
    // own comment (D-21) for why this is plain text rather than hashed.
    codeVerifier: text('code_verifier'),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('person_link_challenges_person_id_idx').on(table.personId),
    check(
      'person_link_challenges_surface_check',
      sql`${table.surface} in ('discord', 'mcp')`
    ),
    // Structural enforcement of this table's own module comment: a
    // `discord` row is issue-time-survivor-bound, an `mcp` row is
    // issue-time-identity-bound — never both, never neither.
    check(
      'person_link_challenges_binding_shape_check',
      sql`(${table.surface} = 'discord' and ${table.personId} is not null and ${table.identityExternalId} is null)
        or (${table.surface} = 'mcp' and ${table.personId} is null and ${table.identityExternalId} is not null)`
    ),
  ]
)

// ADMIN-1..3 — reading a course's transcript is a disclosure event, and
// ADMIN-2 requires it to be written to an audit trail: who read whose
// conversation, and when. One row per *request*, not per message —
// `repos/transcript-access.ts#readCourseTranscript` is the single function
// both `transcripts.read` (ADMIN-1) and `transcripts.export` (ADMIN-3) call
// to actually fetch the messages, and it writes this row in the same call,
// so a future third caller of that function is audited for free rather
// than having to remember a separate "log it" step of its own — the design
// ADMIN-2's own text asks for ("the recording should live where the read
// happens, not in the one screen that happens to call it today").
export const TRANSCRIPT_ACCESS_KINDS = ['read', 'export'] as const
export type TranscriptAccessKind = (typeof TRANSCRIPT_ACCESS_KINDS)[number]

export const transcriptAccessLog = sqliteTable(
  'transcript_access_log',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id),
    // The instructor (or other accountable staff member) who read or
    // exported — never null: `repos/transcript-access.ts` refuses to log,
    // or to run the read at all, without one (see that file's own module
    // comment).
    actorAccountId: text('actor_account_id')
      .notNull()
      .references(() => accounts.id),
    // Which student's conversation this access named, or `null` for an
    // unfiltered read/export across the whole course — ADMIN-2's "who read
    // whose conversation" for the common, single-student case, and an
    // honest "nobody in particular, everybody in the course" for the other.
    personId: text('person_id').references(() => people.id),
    kind: text('kind', { enum: TRANSCRIPT_ACCESS_KINDS }).notNull(),
    // The date filter actually applied, if any (ADMIN-1's own "filtered by
    // ... date") — recorded alongside the access itself so the audit trail
    // says not just *that* a read happened but what it covered.
    startAt: integer('start_at'),
    endAt: integer('end_at'),
    // A real tiebreaker for `listAccessLogForCourse`'s "newest first" order
    // — the same reason `messages.sequence`/`transcript_exports.sequence`
    // exist (those tables' own comments): `createdAt` is millisecond
    // precision, and two reads (an instructor's screen and a concurrent
    // export job, say) can land within the same millisecond. Assigned by
    // `repos/transcript-access.ts#readCourseTranscript` inside the same
    // transaction as the read and the insert it accompanies, one more than
    // the highest already recorded for this course.
    //
    // `.default(0)`, unlike its siblings on `messages`/`course_instruction_revisions`/
    // `transcript_exports`: this column was added to an *already-shipped*
    // table by a later migration (`0013_opposite_selene.sql`), which makes
    // it the one `sequence` column in this file that a real, already-running
    // deployment can have existing rows to violate `NOT NULL` against —
    // every other one was part of its own table's original `CREATE TABLE`,
    // so a fresh table with no rows yet closes the same gap structurally.
    // A rework finding: this used to have no default at all — a plain
    // `ALTER TABLE ... ADD sequence integer NOT NULL` — which SQLite
    // accepts only on an empty table, and refuses (rolling the whole
    // migration back, no partial effect) the moment a real deployment
    // already has one `transcript_access_log` row, which any reviewer who
    // ran ADMIN-1's own read even once already does; both `apps/api` and
    // `apps/worker` call `runMigrations` at boot, so that migration
    // refused every one of those processes' own startup. `0` is a safe
    // backfill value precisely because it is wrong in the same direction
    // reading a transcript already is: an old row backfilled to `0` sorts
    // as if it happened first, which is the least-recent position
    // `desc(sequence)` gives it anyway once a real `sequence` value exists
    // for anything read after this migration runs.
    sequence: integer('sequence').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('transcript_access_log_course_id_idx').on(table.courseId),
    index('transcript_access_log_organization_id_idx').on(table.organizationId),
    check(
      'transcript_access_log_kind_check',
      sql`${table.kind} in ('read', 'export')`
    ),
  ]
)

// ADMIN-3 — an export is a job (JOB-1): an instructor asks, a file is
// produced, they collect it. `status` mirrors `course_attachments`' own
// pending/ready/failed lifecycle (this file's own comment on
// `ATTACHMENT_STATUSES`) for the same reason — a caller needs to tell
// "still working" from "dead" rather than polling a job row whose own
// `result` this table's `id` is merely named inside.
export const TRANSCRIPT_EXPORT_STATUSES = [
  'pending',
  'ready',
  'failed',
] as const
export type TranscriptExportStatus = (typeof TRANSCRIPT_EXPORT_STATUSES)[number]

export const transcriptExports = sqliteTable(
  'transcript_exports',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    courseId: text('course_id')
      .notNull()
      .references(() => courses.id),
    // `null` — every student the course's transcript covers; set — one
    // student's own history, the shape PPL-5's own `hasVerifiedAddress`
    // gate applies to (see `packages/actions/src/actions/transcripts.ts`'s
    // own module comment for the reasoning).
    personId: text('person_id').references(() => people.id),
    requestedByAccountId: text('requested_by_account_id')
      .notNull()
      .references(() => accounts.id),
    status: text('status', { enum: TRANSCRIPT_EXPORT_STATUSES }).notNull(),
    startAt: integer('start_at'),
    endAt: integer('end_at'),
    // Set once the job produces the file — the bytes themselves live in
    // FILE-5's own `AttachmentStorage`, addressed by this row's own `id`
    // (`apps/worker`'s handler writes them there, never this table).
    filename: text('filename'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    failureReason: text('failure_reason'),
    // A real tiebreaker for `listExportsForCourse`'s "most recent first"
    // order — the same reason `course_instruction_revisions.sequence`
    // exists (that table's own comment): `createdAt` is millisecond
    // precision, two exports can be requested within the same millisecond,
    // and SQL defines no order among rows tied on the `ORDER BY` column.
    // Assigned by `repos/transcript-exports.ts#createPendingExport` inside
    // its own transaction, one more than the highest already recorded for
    // this course.
    sequence: integer('sequence').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('transcript_exports_course_id_idx').on(table.courseId),
    index('transcript_exports_organization_id_idx').on(table.organizationId),
    check(
      'transcript_exports_status_check',
      sql`${table.status} in ('pending', 'ready', 'failed')`
    ),
  ]
)

// ADMIN-5 — deleting a tenant's data is a platform-administrator operation,
// separate from TEN-6's "removal preserves data" (removing a bot from a
// server, which never deletes anything). This table is the audit record
// that operation leaves behind, deliberately *not* scoped by — or
// foreign-keyed to — `organizations.id` the way every other table in this
// file is: the whole point of the row is to outlive the organization it
// describes, so `organizationId` here is a plain value, not a reference
// this platform's own deletion would immediately have to violate.
export const tenantDeletions = sqliteTable('tenant_deletions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  // Captured before the delete, since the row it would otherwise be read
  // from is gone immediately afterward — an audit entry that could only be
  // read back as "(unknown organization)" once its own subject no longer
  // exists would defeat the point of keeping it.
  organizationName: text('organization_name').notNull(),
  deletedByAccountId: text('deleted_by_account_id')
    .notNull()
    .references(() => accounts.id),
  // What was actually removed, as `repos/organizations.ts#deleteOrganizationData`'s
  // own summary reports it — opaque JSON here, the same "not this table's
  // to interpret" discipline `jobs.result` (above) already holds itself to.
  summary: text('summary').notNull(),
  deletedAt: integer('deleted_at').notNull(),
})
