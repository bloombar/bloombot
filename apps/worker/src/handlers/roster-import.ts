/**
 * The `roster.import` job handler (ROST-9..12) — this platform's
 * `roster_create_channels.py` (plus the merged-CSV half of `roster_setup.ipynb`
 * — see this file's own note on scope, below), moved behind the queue,
 * organization-scoped, and reporting rather than printing to a console an
 * instructor never sees.
 *
 * **Enrolment (ENRL-3)**: a roster row is one of the three admission
 * decisions this platform recognizes — every row this handler resolves to a
 * person (whether newly created or merged onto an existing one) is enrolled
 * in the course via `@bloombot/db`'s `enrolments.enrolViaRoster`, recording
 * `source: 'roster'`. A re-import of the same roster does not duplicate the
 * enrolment (`enrolViaRoster`'s own idempotency), and does not resurrect one
 * an instructor has since ended (ENRL-6) — `enrolViaRoster`'s own doc
 * comment has the reasoning (rework finding 3).
 *
 * **Scope**: the CSV this handler parses is the *merged* five-column shape
 * `roster_create_channels.py` itself reads (`Last`, `First`, `Email`,
 * `GitHub`, `Discord` — `@bloombot/schemas`' `parseRosterCsv`), not the
 * registrar's raw roster before it is joined with an intake questionnaire.
 * That join (`roster_setup.ipynb`, ROST-2) is `packages/legacy-import`'s
 * concern; this slice's own brief names it explicitly out of scope. See
 * `docs/DECISIONS.md` for the fuller reasoning.
 *
 * **Person resolution (ROST-10)**: a row's Discord handle is looked up
 * against the guild's own member list (`DiscordRestClient#listGuildMembers`,
 * this slice's own addition to that port) the same way
 * `discord_manager.py`'s `get_user_id` does — username or display name,
 * case-insensitively, ignoring anything after a `#`. When it resolves, the
 * member's real snowflake is the identity this row is kept under
 * (`surface: 'discord'`), the same identity a live message from that member
 * would resolve to later (PPL-3) — so a student who has already joined the
 * server when the roster is imported is genuinely recognized the moment
 * they first message the bot. When it does *not* resolve — the common case
 * at import time, since a roster is typically imported before students join
 * (ROST-3's own channels-ahead-of-arrival workflow) — the row is still kept,
 * under a synthetic identity keyed by the handle itself
 * (`handle:<normalized handle>`), so a re-import of the same roster (or a
 * correction to the same handle) still recognizes the same person and merges
 * onto it rather than creating a duplicate. Rework (D-31's own "identity-model
 * gap" update): this `handle:`-keyed person *is* reconciled with the one
 * PPL-3 would otherwise separately create the moment that student's first
 * live message arrives — `packages/discord`'s `handleMention` now checks for
 * a matching `handle:`-keyed identity before minting a new person for an
 * unresolved snowflake. Nothing in this file changed to make that true; see
 * `handle-mention.ts`'s own module comment and `docs/DECISIONS.md` for the
 * mechanics and what it deliberately still does not do.
 *
 * **Roster fields are merged, never overwritten (PPL-4)**: `mergeRosterFields`
 * fills in only what a surface has not already proven about this person —
 * exactly PPL-4's "a roster corroborates, it does not overwrite" — never
 * `overwriteRosterFields`, which this handler does not use at all.
 *
 * **Channels (ROST-11)**: one private channel per student, inside the
 * course's own numbered `… - STUDENTS NN` categories (CFG-4) — matched by a
 * name ending in "students <number>", case-insensitively, sorted ascending
 * by that number. Each category must already exist in the guild (created by
 * an earlier `discordServers.scaffold` run, the previous slice's own job) —
 * this handler creates channels *inside* a student category, never a new
 * category of its own; a course with no numbered student categories
 * scaffolded yet, or with every one already full, gets every remaining
 * student's channel reported under `channelsNotCreated` (ROST-12) rather
 * than a category invented on the spot. A student category's *current*
 * channel count (read fresh from the guild, including this run's own
 * earlier creations) is what "full" means, matched against
 * `categoryChannelCap` — configurable so a test does not need fifty
 * students to prove the spillover, defaulting to Discord's own real limit,
 * 50.
 *
 * **Idempotence (ROST-11)**: a channel is matched, across every student
 * category, by its slugged name (`normalizeChannelName`, the same transform
 * `discord-scaffold.ts` applies for the same Discord-side-slugging reason —
 * see that file's own module comment) before this handler creates anything
 * — already-present is reported, never duplicated. Rework finding 5: an
 * already-present channel's permissions are *not* frozen forever the way
 * `discord-scaffold.ts`'s own SRV-8 discipline freezes a course's shared
 * channels — a re-import that can now resolve a handle it could not at
 * creation time (the student has since joined the server) grants that one
 * student read/send access on their own already-existing channel, through
 * `DiscordRestClient#grantChannelMemberAccess`, this rework's narrowly
 * scoped exception to "no edit verb" (see that method's own doc comment and
 * `docs/DECISIONS.md` for why this does not reopen SRV-8). The welcome
 * message ROST-6 also describes is still not sent or pinned at all — no
 * verb for it exists, and this run says so plainly in its own report
 * (`RosterImportReport.limitations`), not only in `docs/DECISIONS.md`.
 */

import { courses, discordServers, enrolments, people } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import { parseRosterCsv, type RosterParseError } from '@bloombot/schemas'
import {
  allowMemberOverwrite,
  allowRoleOverwrite,
  denyEveryoneOverwrite,
  DiscordRequestError,
  overwriteAllowsView,
  type DiscordChannel,
  type DiscordGuildMember,
  type DiscordPermissionOverwrite,
  type DiscordRestClient,
} from '@bloombot/discord-rest'

type CourseWithCategories = NonNullable<ReturnType<typeof courses.getCourse>>
type CourseCategoryWithChannels = CourseWithCategories['categories'][number]

/** Discord's own channel-type enum (API v10) — the one value this handler needs to tell a category apart from a text channel in a flat `listGuildChannels` response, the same constant `discord-scaffold.ts` defines for itself (not shared across files — see that file's own module comment on why an app does not share this kind of thing across handlers via a package it does not own). */
const CHANNEL_TYPE_GUILD_CATEGORY = 4

/**
 * The job `kind` this handler is registered under (`index.ts`), and the one
 * `@bloombot/actions`' `roster.import` action enqueues
 * (`packages/actions/src/actions/roster.ts`) — a literal string in both
 * places, the same cross-referenced-by-comment convention
 * `DISCORD_SCAFFOLD_JOB_KIND` already uses, for the same reason: an app does
 * not import from another app, and a package does not depend on
 * `apps/worker`.
 */
export const ROSTER_IMPORT_JOB_KIND = 'roster.import'

export interface RosterImportHandlerDependencies {
  discordRestClient: DiscordRestClient
  botToken: string
  /**
   * Discord's own per-category channel cap. Defaults to 50, Discord's real
   * limit — overridable so a test can prove ROST-11's spillover with a
   * handful of students rather than fifty.
   */
  categoryChannelCap?: number
}

/** One row that already parsed (ROST-9), tagged with its own CSV line — carried through the rest of this handler so every later report entry (an unresolved handle, a channel that could not be created) can still say which line it came from. */
interface RosterRowWithLine {
  line: number
  first: string
  last: string
  email: string
  discord: string
  github: string
}

export interface PersonReportEntry {
  line: number
  discord: string
  personId: string
}

export interface UnresolvedHandleEntry {
  line: number
  discord: string
  email: string
}

/** Rework finding 8: more than one guild member's own nickname/display name matches a row's handle — resolving to either one would be a guess, and the wrong guess hands that student's channel access and roster fields to a stranger. Reported instead, the same "refuse rather than guess" treatment `resolveIdentity`'s own module comment (`people.ts`) holds itself to. */
export interface AmbiguousHandleEntry {
  line: number
  discord: string
  email: string
  /** Every member whose display name matched — named so an instructor can tell the two students apart and correct the roster's own handle. */
  matchedDisplayNames: string[]
}

export interface ChannelReportEntry {
  line: number
  email: string
  channelName: string
  category: string
}

export interface ChannelNotCreatedEntry {
  line: number
  email: string
  reason: string
}

/** Rework finding 4: a channel this run tried and failed to create — Discord's own error, not this row's fault, and not a reason to abort the rest of the roster. */
export interface ChannelFailedEntry {
  line: number
  email: string
  channelName: string
  category: string
  reason: string
}

/** Rework finding 6: two different rows' emails slug to the same channel name (`ada@school.edu`/`ada@gmail.com` both to `ada`) — the second is refused a channel entirely rather than silently sharing (or failing to reach) the first's, since this handler has no way to tell which student a shared name actually belongs to. */
export interface ChannelNameCollisionEntry {
  line: number
  email: string
  channelName: string
  /** The row that claimed `channelName` first, this run — named so an instructor knows which two rows to go correct. */
  collidesWithLine: number
  collidesWithEmail: string
}

/** Rework finding 13 (first bullet): a field `mergeRosterFields` declined to change because a surface already proved a different value for this person — named so an instructor who re-imports a corrected roster row can tell the correction did not take, rather than reading `peopleMerged` as unqualified success. */
export interface RosterFieldsDeclinedEntry {
  line: number
  discord: string
  personId: string
  /** Which of `firstName`/`lastName`/`email`/`githubHandle` the roster's own value for this row did not end up stored as (PPL-4's "corroborates, does not overwrite"). */
  fields: string[]
}

/** ROST-9..12's own report — what `@bloombot/actions`' `jobs.get` read action hands back once an import job succeeds. */
export interface RosterImportReport {
  courseId: string
  guildId: string
  /** ROST-9: a row that did not parse, with its own line number. */
  parseErrors: RosterParseError[]
  /** A row whose handle matched nobody yet in this organization — a new person (and identity) was created for it (ROST-10). */
  peopleCreated: PersonReportEntry[]
  /** A row whose handle matched an existing person — the roster's fields were merged onto them (ROST-10, PPL-4). */
  peopleMerged: PersonReportEntry[]
  /** Rework finding 13 (first bullet): every field a merged row's roster value did not end up stored as, because a surface already proved a different one — see `RosterFieldsDeclinedEntry`'s own doc comment. */
  rosterFieldsDeclined: RosterFieldsDeclinedEntry[]
  /** ROST-12: a row's Discord handle did not resolve to a member of the bound guild — the row is still imported (person created/merged, channel still attempted), just without the individual student's own permission grant. */
  unresolvedHandles: UnresolvedHandleEntry[]
  /** Rework finding 8: a row's handle matched more than one guild member's own display name — nobody's channel access or roster fields are guessed at; see `AmbiguousHandleEntry`'s own doc comment. */
  ambiguousHandles: AmbiguousHandleEntry[]
  /** ROST-11: a channel newly created this run. */
  channelsCreated: ChannelReportEntry[]
  /** ROST-12: "students already present" — a channel for this student already existed (in a matched student category) and needed no repair (SRV-8; the handle either does not resolve, or the resolved member already had access). */
  channelsAlreadyPresent: ChannelReportEntry[]
  /** Rework finding 5: a channel for this student already existed, and this run granted the newly-resolved member read/send access on it through `DiscordRestClient#grantChannelMemberAccess` — a late-joining student's channel, repaired rather than left admin-only forever. */
  channelAccessGranted: ChannelReportEntry[]
  /** Rework finding 5: this run tried and failed to repair an already-present channel's access for a newly-resolved member — Discord's own error, and not a reason to abort the rest of the roster. */
  channelAccessGrantFailed: ChannelFailedEntry[]
  /** ROST-12: a channel this run could not create, and why (every matched student category was full, or none exist yet). */
  channelsNotCreated: ChannelNotCreatedEntry[]
  /** Rework finding 4: a channel this run tried and failed to create — Discord's own error (a 429, 403 or 400, say), caught per row so the rest of the roster still imports; see `ChannelFailedEntry`'s own doc comment. */
  channelsFailed: ChannelFailedEntry[]
  /** Rework finding 6: two rows whose emails slug to the same channel name — see `ChannelNameCollisionEntry`'s own doc comment. */
  channelNameCollisions: ChannelNameCollisionEntry[]
  /** A course role name that did not resolve in the guild — the admins overwrite this run applied is missing that grant for every channel it created, the same "skipped rather than fatal" treatment SRV-2 gives `discord-scaffold.ts`'s own role resolution. */
  unresolvedRoles: string[]
  /**
   * Rework finding 13 (second bullet): what this handler structurally
   * cannot do, stated plainly on every run's own report rather than living
   * only in `docs/DECISIONS.md`, which a reader of one run's own results
   * has no reason to have open. Always present, not conditional on anything
   * this particular run happened to encounter.
   */
  limitations: string[]
}

/** Rework finding 13's own text for `limitations` — one entry today (ROST-6's pinned welcome message), kept as a named constant so the report and `docs/DECISIONS.md` can be grepped for the same wording. */
const WELCOME_MESSAGE_NOT_SENT =
  "This run does not send or pin ROST-6's welcome message into a student's channel — packages/discord-rest has no postMessage/pinMessage verb yet. See docs/DECISIONS.md's own entry on this rework."

function parsePayload(raw: unknown): { courseId: string; csvText: string } {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { courseId?: unknown }).courseId !== 'string' ||
    typeof (raw as { csvText?: unknown }).csvText !== 'string'
  ) {
    throw new Error(
      'roster.import: payload must be an object shaped { courseId: string; csvText: string }'
    )
  }
  const payload = raw as { courseId: string; csvText: string }
  return { courseId: payload.courseId, csvText: payload.csvText }
}

/** Case- and whitespace-insensitive name matching — the same normalization `discord-scaffold.ts`'s own `normalizeName` applies to a *category's* own name (Discord does not slug a category's name the way it does a channel's). Duplicated rather than imported: this file and `discord-scaffold.ts` are two handlers in the same app, not a shared library either owns. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** The same slugging transform `discord-scaffold.ts`'s own `normalizeChannelName` applies, for the same reason (Discord silently slugs a `GUILD_TEXT` channel's name at creation) — see this file's own module comment. Duplicated for the same reason `normalizeName` above is. */
function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

function resolveRoleId(
  roles: { id: string; name: string }[],
  roleName: string
): string | undefined {
  return roles.find(
    (role) => normalizeName(role.name) === normalizeName(roleName)
  )?.id
}

/**
 * CFG-4's own convention: "several numbered `… - STUDENTS NN` categories".
 * Matches a category name ending in the word "students" followed by a
 * number — case-insensitively, tolerant of the exact separator an
 * instructor used (`Python - STUDENTS 01`, `Python-Students-2`, …) — and
 * returns that number, or `undefined` for a category this convention does
 * not apply to (a course's `… - GLOBAL` category, say). `docs/DECISIONS.md`
 * has the fuller reasoning for why this handler discovers student
 * categories by name rather than a dedicated flag on `course_categories`.
 */
const STUDENT_CATEGORY_SUFFIX = /students[\s-]*(\d+)\s*$/i
function studentCategoryNumber(name: string): number | undefined {
  const match = STUDENT_CATEGORY_SUFFIX.exec(name.trim())
  if (!match?.[1]) return undefined
  return Number(match[1])
}

/** Strips anything after a `#` and lowercases — the same cleanup `discord_manager.py`'s own `get_user_id` applies to a self-reported handle before comparing it ("usernames are self-reported by students, they mess them up constantly"). */
function normalizeHandle(handle: string): string {
  return (handle.split('#')[0] ?? handle).trim().toLowerCase()
}

/** What `resolveMember` found — a discriminated result rather than `undefined | DiscordGuildMember`, so an ambiguous match (rework finding 8) cannot be mistaken for "resolved" or silently collapsed into "unresolved" by a caller that only checks for a member. */
export type MemberResolution =
  | { kind: 'resolved'; member: DiscordGuildMember }
  | { kind: 'unresolved' }
  | { kind: 'ambiguous'; matches: DiscordGuildMember[] }

/**
 * Resolve a roster row's `Discord` handle to a guild member — username or
 * display name, case-insensitively (`discord_manager.py`'s own
 * `get_user_id(match_display_names=True)`, which `roster_create_channels.py`
 * always passes).
 *
 * Rework finding 8: a plain "username or display name" match gave no
 * precedence to either — a member nicknamed `bob` could match a *different*
 * row's own username `bob`, handing that row's channel access and roster
 * fields to the wrong student. Two changes fix this:
 *
 * - An exact **username** match is tried first and wins outright — a guild
 *   member's own username is unique within a guild (Discord's own
 *   constraint, not this package's), so at most one member can ever match
 *   this way, and a roster's own handle is far more likely to be a
 *   self-reported username than a nickname somebody else assigned them.
 * - Only when no username matches does a **display name** match count —
 *   and if more than one member's own display name matches (two students
 *   who both picked the nickname `bob`, say), that is reported as
 *   `'ambiguous'` rather than this function guessing which one the roster
 *   row meant.
 */
function resolveMember(
  handle: string,
  members: DiscordGuildMember[]
): MemberResolution {
  const target = normalizeHandle(handle)

  const byUsername = members.find(
    (member) => member.username.toLowerCase() === target
  )
  if (byUsername) return { kind: 'resolved', member: byUsername }

  const byDisplayName = members.filter(
    (member) => member.displayName.toLowerCase() === target
  )
  if (byDisplayName.length > 1) {
    return { kind: 'ambiguous', matches: byDisplayName }
  }
  const [onlyMatch] = byDisplayName
  if (onlyMatch) return { kind: 'resolved', member: onlyMatch }

  return { kind: 'unresolved' }
}

/** ROST-3: a channel is named after the local part of the student's email address — a stable, recognizable name that does not depend on the student's own (self-reported, frequently wrong) Discord handle. Slugged the same way every other channel name this app creates is (`normalizeChannelName`), so a later `listGuildChannels` match is comparing like with like. */
function channelNameForEmail(email: string): string {
  const localPart = email.split('@')[0] ?? email
  return normalizeChannelName(localPart)
}

/** Rework finding 5: does `channel`'s own `permissionOverwrites` already grant `memberId` view access? Read from whatever `listGuildChannels` (or this run's own `createGuildChannel`) last returned for it — never re-fetched — so a channel this run already granted access to earlier in the same loop, or one that was created *with* the grant already baked in (the ordinary, non-late-joining case), is not sent a second, redundant `grantChannelMemberAccess` write. */
function memberAlreadyGranted(
  channel: DiscordChannel,
  memberId: string
): boolean {
  const overwrite = (channel.permissionOverwrites ?? []).find(
    (entry) => entry.type === 1 && entry.id === memberId
  )
  return overwrite !== undefined && overwriteAllowsView(overwrite)
}

/** Rework finding 4/5: a human-readable reason for a failed Discord write, without leaking whatever `DiscordRequestError.body` carries (that class's own doc comment explains why it stays out of `.message`) into a report a browser or log line will show verbatim. */
function describeDiscordError(error: unknown): string {
  if (error instanceof DiscordRequestError) {
    return `Discord responded with status ${error.status}`
  }
  return error instanceof Error ? error.message : 'an unknown error'
}

/** One student category this run can place a channel into — its declared name, its real Discord category id, and the channels already inside it (mutated locally as this run creates more, so a later row in the same roster sees an up-to-date count). */
interface CategoryState {
  name: string
  guildCategoryId: string
  channels: DiscordChannel[]
}

/**
 * The course's own declared student categories (CFG-4's numbered
 * convention), in ascending numeric order, each resolved to the guild
 * category `discordServers.scaffold` already created for it. A declared
 * student category not yet present in the guild is *not* included here —
 * this handler never creates a category of its own (this file's own module
 * comment) — so a row landing past the last resolved category is reported
 * under `channelsNotCreated`, not silently skipped.
 */
function loadStudentCategoryStates(
  course: CourseWithCategories,
  existingChannels: DiscordChannel[]
): CategoryState[] {
  const guildCategories = existingChannels.filter(
    (channel) => channel.type === CHANNEL_TYPE_GUILD_CATEGORY
  )

  const declaredStudentCategories: {
    category: CourseCategoryWithChannels
    number: number
  }[] = []
  for (const category of course.categories) {
    const number = studentCategoryNumber(category.name)
    if (number !== undefined) {
      declaredStudentCategories.push({ category, number })
    }
  }
  declaredStudentCategories.sort((a, b) => a.number - b.number)

  const states: CategoryState[] = []
  for (const { category } of declaredStudentCategories) {
    const guildCategory = guildCategories.find(
      (candidate) =>
        normalizeName(candidate.name) === normalizeName(category.name)
    )
    if (!guildCategory) continue // Not scaffolded in the guild yet — nothing to place a channel into.
    states.push({
      name: category.name,
      guildCategoryId: guildCategory.id,
      channels: existingChannels.filter(
        (channel) => channel.parentId === guildCategory.id
      ),
    })
  }
  return states
}

/**
 * Runs one roster import. Loads the course and its bound guild through the
 * usual organization-scoped repo functions (TEN-2) — a payload naming
 * another organization's course resolves to nothing here exactly as it does
 * in `discordServers.scaffold` (`discord-scaffold.ts`'s own module comment
 * has the general case), refusing the whole job rather than reaching across
 * a tenant boundary.
 */
export function createRosterImportHandler(
  deps: RosterImportHandlerDependencies
): JobHandler {
  const categoryChannelCap = deps.categoryChannelCap ?? 50

  return async (
    rawPayload: unknown,
    context: JobContext
  ): Promise<RosterImportReport> => {
    const payload = parsePayload(rawPayload)

    const course: CourseWithCategories | undefined = courses.getCourse(
      context.organizationId,
      payload.courseId,
      context.db
    )
    if (!course) {
      throw new Error(
        `roster.import: course "${payload.courseId}" was not found in this organization`
      )
    }

    // TEN-9 — resolved through the course's own server, not "the
    // organization's one binding": before this, an organization installing
    // a second server (this slice's own point) made every roster import
    // fail — including for courses in the server that had worked the day
    // before — with a message that claimed no server was bound when two
    // were (`getActiveDiscordServerBindingForOrganization`'s own
    // `length === 1` guard, undefined for both "none" and "more than one").
    const serverResolution = discordServers.resolveCourseDiscordServer(
      context.organizationId,
      course.discordServerId,
      context.db
    )
    if (!serverResolution.ok) {
      throw new Error(
        serverResolution.reason === 'ambiguous'
          ? `roster.import: organization "${context.organizationId}" has more than one active Discord server, and course "${course.id}" does not say which one it routes in`
          : `roster.import: course "${course.id}" is bound to a Discord server that is no longer active`
      )
    }
    if (!serverResolution.binding) {
      throw new Error(
        `roster.import: organization "${context.organizationId}" has no active Discord server bound`
      )
    }
    const guildId = serverResolution.binding.serverId

    const { rows: parsedRows, errors: parseErrors } = parseRosterCsv(
      payload.csvText
    )
    const rows: RosterRowWithLine[] = parsedRows.map(({ line, row }) => ({
      line,
      ...row,
    }))

    const [existingChannels, roles, members] = await Promise.all([
      deps.discordRestClient.listGuildChannels(deps.botToken, guildId),
      deps.discordRestClient.listGuildRoles(deps.botToken, guildId),
      deps.discordRestClient.listGuildMembers(deps.botToken, guildId),
    ])

    const unresolvedRoles: string[] = []
    const adminsRoleId = resolveRoleId(roles, course.adminsRole)
    if (!adminsRoleId) unresolvedRoles.push(course.adminsRole)

    const categoryStates = loadStudentCategoryStates(course, existingChannels)

    const report: RosterImportReport = {
      courseId: course.id,
      guildId,
      parseErrors,
      peopleCreated: [],
      peopleMerged: [],
      rosterFieldsDeclined: [],
      unresolvedHandles: [],
      ambiguousHandles: [],
      channelsCreated: [],
      channelsAlreadyPresent: [],
      channelAccessGranted: [],
      channelAccessGrantFailed: [],
      channelsNotCreated: [],
      channelsFailed: [],
      channelNameCollisions: [],
      unresolvedRoles,
      limitations: [WELCOME_MESSAGE_NOT_SENT],
    }

    // Rework finding 6: which row, this run, first claimed a given slugged
    // channel name — so a second row with a *different* email but the same
    // local part (`ada@school.edu`/`ada@gmail.com`, both `ada`) is reported
    // as a collision instead of silently sharing (or failing to reach) the
    // first row's own channel. Keyed purely from the CSV's own data, before
    // any Discord call, so a collision is caught even for a row whose own
    // channel creation later fails or has no room (`channelsFailed`/
    // `channelsNotCreated`).
    const channelNameOwners = new Map<string, { line: number; email: string }>()

    for (const row of rows) {
      // ---- ROST-10: person resolution, merged never overwritten (PPL-4) ----
      const resolution = resolveMember(row.discord, members)
      const member =
        resolution.kind === 'resolved' ? resolution.member : undefined
      // See this file's own module comment: a resolved member's real
      // snowflake is used when available (recognized by any later message
      // from that same account); an unresolved (or ambiguous — rework
      // finding 8) handle falls back to a synthetic, handle-keyed identity
      // so the row is still kept and a re-import still recognizes it, at
      // the cost of not yet reconciling with a snowflake identity
      // established later.
      const identity = {
        surface: 'discord' as const,
        externalId: member
          ? member.id
          : `handle:${normalizeHandle(row.discord)}`,
      }
      const existedBeforehand = people.resolveIdentity(
        context.organizationId,
        identity,
        context.db
      )
      const person = people.resolvePersonByIdentity(
        context.organizationId,
        identity,
        context.db
      )
      const desiredFields = {
        firstName: row.first || null,
        lastName: row.last || null,
        email: row.email || null,
        githubHandle: row.github || null,
      } as const
      const mergedPerson = people.mergeRosterFields(
        context.organizationId,
        person.id,
        desiredFields,
        context.db
      )
      // ENRL-3: a roster row is one of the three admission decisions — this
      // is what actually enrols the row's person into the course, recording
      // `source: 'roster'`. Idempotent the same way person resolution above
      // is (`enrolments.ts#admit`): a re-import of the same roster leaves
      // an already-active enrolment exactly as it found it, rather than
      // erroring or duplicating it. Rework finding 3: it also leaves an
      // *ended* enrolment (ENRL-6) exactly as ended — `enrolViaRoster`'s own
      // doc comment — so re-importing the term's roster after an instructor
      // has removed a student does not quietly bring them back.
      enrolments.enrolViaRoster(
        context.organizationId,
        { courseId: course.id, personId: person.id },
        context.db
      )
      // Rework finding 13 (first bullet): `mergeRosterFields` only ever
      // fills a field that was `null` (PPL-4) — a field the roster asked
      // for but that did not end up stored as the roster's own value was
      // declined because a surface already proved a different one, not
      // because anything failed. Compared against what actually landed,
      // not merely re-asserted from `desiredFields`, so a re-import of a
      // corrected roster row can tell the correction did not take.
      const declinedFields = (
        [
          ['firstName', desiredFields.firstName],
          ['lastName', desiredFields.lastName],
          ['email', desiredFields.email],
          ['githubHandle', desiredFields.githubHandle],
        ] as const
      )
        .filter(
          ([field, desired]) =>
            desired !== null && mergedPerson?.[field] !== desired
        )
        .map(([field]) => field)
      if (declinedFields.length > 0) {
        report.rosterFieldsDeclined.push({
          line: row.line,
          discord: row.discord,
          personId: person.id,
          fields: declinedFields,
        })
      }
      const personEntry: PersonReportEntry = {
        line: row.line,
        discord: row.discord,
        personId: person.id,
      }
      if (existedBeforehand) {
        report.peopleMerged.push(personEntry)
      } else {
        report.peopleCreated.push(personEntry)
      }
      if (resolution.kind === 'unresolved') {
        report.unresolvedHandles.push({
          line: row.line,
          discord: row.discord,
          email: row.email,
        })
      } else if (resolution.kind === 'ambiguous') {
        report.ambiguousHandles.push({
          line: row.line,
          discord: row.discord,
          email: row.email,
          matchedDisplayNames: resolution.matches.map((m) => m.displayName),
        })
      }

      // ---- ROST-11/ROST-12: the student's private channel ----
      const channelName = channelNameForEmail(row.email)

      // Rework finding 6 — see `channelNameOwners`'s own comment above.
      const owner = channelNameOwners.get(channelName)
      if (owner && owner.email !== row.email) {
        report.channelNameCollisions.push({
          line: row.line,
          email: row.email,
          channelName,
          collidesWithLine: owner.line,
          collidesWithEmail: owner.email,
        })
        continue
      }
      if (!owner)
        channelNameOwners.set(channelName, { line: row.line, email: row.email })

      const alreadyPresent = categoryStates
        .flatMap((state) =>
          state.channels.map((channel) => ({ channel, category: state.name }))
        )
        .find(
          ({ channel }) => normalizeChannelName(channel.name) === channelName
        )
      if (alreadyPresent) {
        // Rework finding 5: a channel that already exists is no longer
        // frozen forever for the one student it belongs to — a handle that
        // now resolves (the student has since joined the server) gets its
        // access repaired, through the one narrowly-scoped write this
        // package makes to a channel it did not just create.
        if (
          member &&
          !memberAlreadyGranted(alreadyPresent.channel, member.id)
        ) {
          try {
            await deps.discordRestClient.grantChannelMemberAccess(
              deps.botToken,
              alreadyPresent.channel.id,
              member.id
            )
            report.channelAccessGranted.push({
              line: row.line,
              email: row.email,
              channelName,
              category: alreadyPresent.category,
            })
          } catch (error) {
            report.channelAccessGrantFailed.push({
              line: row.line,
              email: row.email,
              channelName,
              category: alreadyPresent.category,
              reason: describeDiscordError(error),
            })
          }
        } else {
          report.channelsAlreadyPresent.push({
            line: row.line,
            email: row.email,
            channelName,
            category: alreadyPresent.category,
          })
        }
        continue
      }

      const target = categoryStates.find(
        (state) => state.channels.length < categoryChannelCap
      )
      if (!target) {
        report.channelsNotCreated.push({
          line: row.line,
          email: row.email,
          reason:
            categoryStates.length === 0
              ? 'no student category has been scaffolded for this course yet'
              : 'every student category is full',
        })
        continue
      }

      const overwrites: DiscordPermissionOverwrite[] = [
        denyEveryoneOverwrite(guildId),
        ...(adminsRoleId ? [allowRoleOverwrite(adminsRoleId)] : []),
        // ROST-5/ROST-12: a handle that did not resolve still gets a
        // channel — with admin access only, and already reported above
        // under `unresolvedHandles`/`ambiguousHandles` — rather than
        // aborting the row.
        ...(member ? [allowMemberOverwrite(member.id)] : []),
      ]

      // Rework finding 4: one Discord error (a 429, 403 or 400) must not
      // abort the whole import — caught per row, recorded with its reason,
      // and the rest of the roster still runs. Before this, a single failed
      // create threw straight out of this handler, and with the queue's own
      // retries and handler timeout, a large roster could end `failed` with
      // most rows already imported and nothing readable to show for it.
      try {
        const created = await deps.discordRestClient.createGuildChannel(
          deps.botToken,
          guildId,
          {
            name: channelName,
            parentId: target.guildCategoryId,
            permissionOverwrites: overwrites,
          }
        )
        // Mutated locally so a later row in this same roster sees this
        // channel already counted against `target`'s own cap (ROST-11's
        // spillover) and already present (a duplicate row for the same
        // student in one file matches it, rather than creating a second
        // channel).
        target.channels = [...target.channels, created]
        report.channelsCreated.push({
          line: row.line,
          email: row.email,
          channelName: created.name,
          category: target.name,
        })
      } catch (error) {
        report.channelsFailed.push({
          line: row.line,
          email: row.email,
          channelName,
          category: target.name,
          reason: describeDiscordError(error),
        })
      }
    }

    return report
  }
}
