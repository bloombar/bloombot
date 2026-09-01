/**
 * The `roster.import` job handler (ROST-9..12) — this platform's
 * `roster_create_channels.py` (plus the merged-CSV half of `roster_setup.ipynb`
 * — see this file's own note on scope, below), moved behind the queue,
 * organization-scoped, and reporting rather than printing to a console an
 * instructor never sees.
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
 * onto it rather than creating a duplicate. `docs/DECISIONS.md` is explicit
 * about what this does *not* do: nothing here reconciles a `handle:`-keyed
 * person with the snowflake-keyed identity PPL-3 creates once that student
 * actually messages the bot — that reconciliation is out of this slice's
 * scope (it would mean teaching message-time resolution, in `packages/core`/
 * `apps/bot`, to also try a roster-handle fallback, and neither is named in
 * this slice's brief).
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
 * — already-present is reported, never duplicated, and (SRV-8, carried over
 * unchanged from the scaffold handler) never has its permissions rewritten
 * on a re-run: `DiscordRestClient` still has no edit verb, and this handler
 * does not add one. ROST-6's own "re-runs update permissions on existing
 * channels" is therefore *not* carried over — `docs/DECISIONS.md` says so
 * explicitly, alongside the welcome message, which this handler does not
 * send or pin at all (no verb for it either — see `docs/DECISIONS.md` and
 * this slice's own report).
 */

import { courses, discordServers, people } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import { parseRosterCsv, type RosterParseError } from '@bloombot/schemas'
import {
  allowMemberOverwrite,
  allowRoleOverwrite,
  denyEveryoneOverwrite,
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
  /** ROST-12: a row's Discord handle did not resolve to a member of the bound guild — the row is still imported (person created/merged, channel still attempted), just without the individual student's own permission grant. */
  unresolvedHandles: UnresolvedHandleEntry[]
  /** ROST-11: a channel newly created this run. */
  channelsCreated: ChannelReportEntry[]
  /** ROST-12: "students already present" — a channel for this student already existed (in a matched student category), so nothing was created or rewritten (SRV-8). */
  channelsAlreadyPresent: ChannelReportEntry[]
  /** ROST-12: a channel this run could not create, and why (every matched student category was full, or none exist yet). */
  channelsNotCreated: ChannelNotCreatedEntry[]
  /** A course role name that did not resolve in the guild — the admins overwrite this run applied is missing that grant for every channel it created, the same "skipped rather than fatal" treatment SRV-2 gives `discord-scaffold.ts`'s own role resolution. */
  unresolvedRoles: string[]
}

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

/** Resolve a roster row's `Discord` handle to a guild member — username or display name, case-insensitively (`discord_manager.py`'s own `get_user_id(match_display_names=True)`, which `roster_create_channels.py` always passes). `undefined` when nothing in `members` matches — ROST-12's "handle does not resolve", the caller's to report. */
function resolveMember(
  handle: string,
  members: DiscordGuildMember[]
): DiscordGuildMember | undefined {
  const target = normalizeHandle(handle)
  return members.find(
    (member) =>
      member.username.toLowerCase() === target ||
      member.displayName.toLowerCase() === target
  )
}

/** ROST-3: a channel is named after the local part of the student's email address — a stable, recognizable name that does not depend on the student's own (self-reported, frequently wrong) Discord handle. Slugged the same way every other channel name this app creates is (`normalizeChannelName`), so a later `listGuildChannels` match is comparing like with like. */
function channelNameForEmail(email: string): string {
  const localPart = email.split('@')[0] ?? email
  return normalizeChannelName(localPart)
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

    const binding = discordServers.getActiveDiscordServerBindingForOrganization(
      context.organizationId,
      context.db
    )
    if (!binding) {
      throw new Error(
        `roster.import: organization "${context.organizationId}" has no active Discord server bound`
      )
    }
    const guildId = binding.serverId

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
      unresolvedHandles: [],
      channelsCreated: [],
      channelsAlreadyPresent: [],
      channelsNotCreated: [],
      unresolvedRoles,
    }

    for (const row of rows) {
      // ---- ROST-10: person resolution, merged never overwritten (PPL-4) ----
      const member = resolveMember(row.discord, members)
      // See this file's own module comment: a resolved member's real
      // snowflake is used when available (recognized by any later message
      // from that same account); an unresolved handle falls back to a
      // synthetic, handle-keyed identity so the row is still kept and a
      // re-import still recognizes it, at the cost of not yet reconciling
      // with a snowflake identity established later.
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
      people.mergeRosterFields(
        context.organizationId,
        person.id,
        {
          firstName: row.first || null,
          lastName: row.last || null,
          email: row.email || null,
          githubHandle: row.github || null,
        },
        context.db
      )
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
      if (!member) {
        report.unresolvedHandles.push({
          line: row.line,
          discord: row.discord,
          email: row.email,
        })
      }

      // ---- ROST-11/ROST-12: the student's private channel ----
      const channelName = channelNameForEmail(row.email)
      const alreadyPresent = categoryStates
        .flatMap((state) =>
          state.channels.map((channel) => ({ channel, category: state.name }))
        )
        .find(
          ({ channel }) => normalizeChannelName(channel.name) === channelName
        )
      if (alreadyPresent) {
        report.channelsAlreadyPresent.push({
          line: row.line,
          email: row.email,
          channelName,
          category: alreadyPresent.category,
        })
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
        // under `unresolvedHandles` — rather than aborting the row.
        ...(member ? [allowMemberOverwrite(member.id)] : []),
      ]

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
    }

    return report
  }
}
