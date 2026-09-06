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
 * **Two rows whose emails share a local part still both get a channel
 * (ROST-14)**: a channel is named after the local part of the student's
 * email (ROST-3), so `ada@school.edu` and `ada@gmail.com` both slug to
 * `ada`. Rather than refusing the second row a channel entirely (the old
 * behaviour this superseded — a student who cannot be given a channel
 * cannot be answered privately), or numbering the rows in whatever order
 * they happen to appear in the file (this slice's own first draft, reverted
 * — see `docs/DECISIONS.md`'s own entry on ROST-14 for why an ordinal tied to row position
 * is a defect, not a scope note: it can hand two different students *each
 * other's* channel across two imports of a roster that merely gained or
 * lost a row), every row's name is a pure function of the *set* of distinct
 * addresses in this roster — `assignChannelNames`, below — so no ordering
 * of any roster containing the same addresses ever produces a different
 * name for any of them.
 *
 * **A channel is remembered, not re-derived (ROST-17)**: everything above
 * finds a student's channel by recomputing the name their address would
 * produce today and looking for that name in the guild — which only works
 * while that name never changes, and ROST-14's own disambiguation is one of
 * several ordinary reasons it does (an instructor renames a channel by
 * hand; an address is corrected). `roster_channel_assignments`
 * (`@bloombot/db`'s `rosterChannelAssignments`) is the durable record this
 * handler consults *first*, for every row, before any of the name-based
 * matching below ever runs: a person with a remembered channel for this
 * course has it looked up by id, verified (ROST-16) and reported present,
 * never re-derived by name at all — and a remembered channel that no
 * longer exists in the guild is recreated, rather than left as a record
 * pointing at nothing. Only a row with no remembered channel reaches the
 * name-based matching and `channelBelongsToSomeoneElse` ownership guard
 * below, and adopting a match that way records it, so the *next* import of
 * the same roster finds it by id too. Adoption itself still refuses a
 * match already remembered as a *different* person's outright — a name
 * collision `channelBelongsToSomeoneElse`'s own narrow, roster-scoped test
 * cannot see on its own, which is exactly the gap that function's own doc
 * comment names as ROST-17's to close.
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

import { createHash } from 'node:crypto'

import {
  courses,
  discordServers,
  enrolments,
  people,
  rosterChannelAssignments,
} from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import { parseRosterCsv, type RosterParseError } from '@bloombot/schemas'
import {
  allowMemberOverwrite,
  allowRoleOverwrite,
  denyEveryoneOverwrite,
  describeDiscordError,
  DiscordRequestError,
  normalizeChannelName,
  overwriteAllowsView,
  type DiscordChannel,
  type DiscordGuildMember,
  type DiscordPermissionOverwrite,
  type DiscordRestClient,
  type UnresolvedRoleEntry,
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

/**
 * ROST-14: a row whose email's local part slugs to the same name as another
 * distinct address in this roster (`ada@school.edu`/`ada@gmail.com` both
 * slug to `ada`) — this row still got a channel, disambiguated by domain
 * (`ada-school`, `ada-gmail`, …) rather than refused one (the old
 * "collision" behaviour this type used to name and document — see this
 * file's own module comment) or numbered by row position (this slice's own
 * reverted first draft — see `docs/DECISIONS.md`'s own entry on ROST-14).
 * Reported so an instructor can still tell the rows apart and correct the
 * underlying address if they would rather have the bare name.
 */
export interface ChannelNameDisambiguatedEntry {
  line: number
  email: string
  /** The plain, local-part-only name this row's channel would have gotten had nothing else in the roster shared it. */
  baseChannelName: string
  /** The name this row's channel actually got, disambiguated from every other address sharing `baseChannelName`. */
  channelName: string
  /** Every other distinct address in this roster this row's name was disambiguated against — named so an instructor can see the whole cluster, not just one counterpart. */
  sharesSlugWith: string[]
}

/**
 * ROST-16: a row whose matched, same-named channel turned out to already
 * belong to somebody else (`channelBelongsToSomeoneElse`'s own doc comment
 * has the check) — this row was given its own channel under a different,
 * free name instead of being granted (or silently denied) access to the
 * one it first matched. Reported plainly, not folded into
 * `channelsCreated` alone, because "this student's channel is not the name
 * you would expect" is exactly the kind of thing an instructor needs to
 * read to go find it, or to understand why two students ended up with
 * differently-shaped names for what looks like the same collision.
 */
export interface ChannelOwnershipConflictEntry {
  line: number
  email: string
  /** The name this row would have matched, that turned out to already grant a different individual member. */
  conflictingChannelName: string
  /** The free name this row's own channel was matched or created under instead — derived from this row's own address (`ownAddressCandidates`), so a later import of the same roster arrives at the identical name and re-adopts it rather than creating another. */
  newChannelName: string
}

/**
 * Round 2's honesty finding, not a defect this slice can close: a name is
 * unique, never permanent (`docs/SPEC.md`'s own amendment to ROST-14). A
 * student's name can legitimately change between two imports — a second
 * `ada` joins and disambiguates the first, an address is corrected — and
 * when it does, the *old* channel is not found (nothing looks for it by
 * anything but its current name) and is not touched, while a new one is
 * created under the new name. The student ends up with two channels, and
 * the old one is left silently granting them. This entry is what keeps
 * that silent: reported once a fresh channel has actually been created for
 * a member who already had view access to some *other* channel this course
 * already placed a student in, naming both, so an instructor can go merge
 * or remove the stale one by hand until ROST-17 remembers a channel by the
 * person it belongs to rather than by its current name and closes this for
 * good. Round 3's must-fix: this used to fire before the create even
 * attempted, so a failed create reported an orphan against a channel that
 * was never made; it is now reported only once `createGuildChannel` itself
 * has resolved.
 */
export interface ChannelOrphanedEntry {
  line: number
  email: string
  /** The channel this student already had, that the new name no longer matches. */
  previousChannelName: string
  /** The new channel this run created because the old one could no longer be found by name. */
  newChannelName: string
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
  /** ROST-14: a row whose channel name was disambiguated by domain because another distinct address in this roster shares its local part — see `ChannelNameDisambiguatedEntry`'s own doc comment. */
  channelNameDisambiguated: ChannelNameDisambiguatedEntry[]
  /** ROST-16: a row whose name match was refused because it already belonged to somebody else, and was given its own channel under a different name instead — see `ChannelOwnershipConflictEntry`'s own doc comment. */
  channelOwnershipConflicts: ChannelOwnershipConflictEntry[]
  /** Round 2's honesty finding: a fresh channel was created for a student who already had a different one under a name this run no longer generates for them — see `ChannelOrphanedEntry`'s own doc comment. */
  channelsOrphaned: ChannelOrphanedEntry[]
  /**
   * A course role name this run could not end up with an id for — before
   * SRV-10, that meant "absent from the guild" (the admins overwrite this
   * run applied would then be missing that grant for every channel it
   * created, SRV-2's "skipped rather than fatal"); since SRV-10, an absent
   * name is created rather than skipped (see `rolesCreated` below), so this
   * now means the name resolved to nothing *and* creating it failed on a
   * *permanent* Discord error too (a `403` for a bot missing Manage Roles,
   * say — `reason` names it, the same as `ChannelFailedEntry`). A transient
   * failure (a `429`, a `5xx`, a raw transport error) is never caught here
   * at all and throws instead, the same as every other Discord call this
   * handler does not wrap in its own per-row `try`/`catch` — see this
   * file's own admins-role resolution, below, for why absorbing one
   * unconditionally would leave a course's channels created moments later
   * missing the admins grant, reported `succeeded`, and never repairable.
   */
  unresolvedRoles: UnresolvedRoleEntry[]
  /** SRV-10: a course role name the guild lacked, created this run with an empty permission bitfield — never one that already resolved (`unresolvedRoles`' own doc comment covers what "still missing" means now). */
  rolesCreated: string[]
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

/** Discord's own slugging of a `GUILD_TEXT` channel's name — `@bloombot/discord-rest`'s `normalizeChannelName` (`channel-naming.ts`'s own module comment has the reasoning for why this is no longer copied by hand into every file that needs it). */

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

/**
 * Discord's own real channel-name limit (API v10) — every name this file
 * generates is capped to it (`composeChannelName`, below), not merely the
 * bare local part: round 3's own must-fix. A disambiguator (a full domain,
 * or a hash) is never shortened to make room, since shortening it is what
 * would reopen the very ties this scheme exists to avoid; the local part is
 * truncated instead; see that function's own doc comment.
 */
const MAX_CHANNEL_NAME_LENGTH = 100

/**
 * Composes a channel name from a local part and a (possibly empty) suffix
 * — `''` for the bare level-1 name, `-<domain>` for level 2, `-<hash>` for
 * level 3 — enforcing `MAX_CHANNEL_NAME_LENGTH` by shortening the local
 * part, never the suffix. Round 3's fix for the length half of must-fix 1:
 * the previous scheme's own disambiguator grew with the local part's own
 * length (four base-36 digits *per character*), so a merely 26-character
 * local part alone could exceed Discord's limit before the suffix was even
 * added, and truncating that disambiguator to fit would have destroyed the
 * very uniqueness it existed to provide. A fixed-length suffix (this
 * file's replacement scheme uses only a full domain or a short hash, never
 * something that scales with the local part) sidesteps that entirely: the
 * local part is the only part that can be arbitrarily long, so it is the
 * only part this function ever shortens.
 */
function composeChannelName(localPart: string, suffix: string): string {
  const base = normalizeChannelName(localPart)
  const maxBaseLength = Math.max(1, MAX_CHANNEL_NAME_LENGTH - suffix.length)
  const truncatedBase =
    base.length > maxBaseLength ? base.slice(0, maxBaseLength) : base
  return normalizeChannelName(`${truncatedBase}${suffix}`).slice(
    0,
    MAX_CHANNEL_NAME_LENGTH
  )
}

/** The domain slugged as one unit — every `.` becomes a `-`, so `school.edu` reads `school-edu` — level 2's own disambiguator (`levelTwoName`, below). Deliberately the *whole* domain in one step, not one label folded in at a time the way an earlier draft of this scheme did: escalating one label per round is exactly what let two addresses whose domains differ only in whether a separator is a `.` or a `-` (`my.school.edu` vs `my-school.edu`, both of which slug to `my-school-edu`) tie at every step and never converge — see `docs/DECISIONS.md`'s own entry on ROST-14 for the hang this caused. Fixed steps, not a loop, is the whole point of this file's replacement scheme. */
function slugDomain(domain: string): string {
  return normalizeChannelName(domain.split('.').join('-'))
}

/**
 * A short, hex-digest disambiguator of the *entire* normalized address
 * (local part and domain together, lowercased) — level 3's own fallback,
 * reached only when even the full domain does not tell two addresses
 * apart (the whitespace-collapse collision above, `ada b@x.edu` versus
 * `ada-b@x.edu`, ties at every level up to here since both slug the same
 * local part *and* share a domain). `sha256` over the whole address means
 * the two addresses that reach this level are hashed as the distinct
 * strings they actually are, not as whatever lossy slug they share.
 * `hashLength` starts small (8 hex characters, below) and is only grown in
 * fixed steps if two addresses still tie at that length — bounded by
 * `HASH_LENGTHS`, never a loop that keeps escalating on its own.
 */
function addressDigest(email: string, hashLength: number): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, hashLength)
}

/** The fixed set of hash lengths level 3 tries, in order, each only reached if every shorter one still ties — see `addressDigest`'s own doc comment. Four fixed sizes, the last one the full `sha256` digest: this is a bounded list, walked at most once, never a loop that can spin. */
const HASH_LENGTHS = [8, 16, 32, 64] as const

/** Level 1: the bare local part — used when no other address in the roster shares it. */
function levelOneName(email: string): string {
  return composeChannelName(email.split('@')[0] ?? email, '')
}

/** Level 2: local part plus the *whole* domain, slugged as one unit — reached only by a group that collided at level 1. */
function levelTwoName(email: string): string {
  const domain = email.split('@')[1] ?? ''
  return composeChannelName(
    email.split('@')[0] ?? email,
    `-${slugDomain(domain)}`
  )
}

/** Level 3: local part plus a hash of the whole address — reached only by a (sub-)group still colliding at level 2. See `addressDigest`'s own doc comment for `hashLength`. */
function levelThreeName(email: string, hashLength: number): string {
  return composeChannelName(
    email.split('@')[0] ?? email,
    `-${addressDigest(email, hashLength)}`
  )
}

/** Groups `items` by `keyFn(item)`, preserving each bucket's own insertion order — the one small helper both `assignChannelNames`' three fixed passes and nothing else in this file needs. */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }
  return groups
}

/**
 * ROST-14, round 3's replacement algorithm: names every distinct email
 * address in one roster, all at once, so the name any one row gets is a
 * pure function of the *set* of addresses this roster contains — never of
 * row order, never of anything outside this roster, and never computed by
 * a loop that keeps escalating until nothing collides.
 *
 * **Why round 2's own escalation loop is gone.** That design folded in one
 * more domain label per round, for as long as two addresses still tied,
 * with no ceiling — and `normalizeChannelName` treats a domain's `.` and a
 * literal `-` identically (both collapse to `-`), so `my.school.edu` and
 * `my-school.edu` produce the *identical* string at every label boundary
 * and the loop never converges. Reproduced against the real handler: three
 * rows, killed at 120s and ~117% CPU, still running. Fuzzed against a
 * 90-address pool, 1074 of 200,000 random rosters hung the same way.
 * Because the loop is synchronous, it blocks the event loop outright — the
 * job's own handler timeout is powerless against code that never yields —
 * so one bad CSV permanently pins a worker core. That draft's own doc
 * comment claimed the escalation "always eventually stops colliding,"
 * which this bug disproves; nothing here repeats that claim about
 * anything this file cannot actually prove terminates.
 *
 * **The replacement: three fixed levels, no loop over levels.** Level 1 is
 * the bare local part (`levelOneName`). Level 2 folds in the *whole*
 * domain in one step, not one label at a time (`levelTwoName`) — an
 * address only reaches this level if it collided with another at level 1.
 * Level 3 is a hash of the entire address (`levelThreeName`), reached only
 * by a (sub-)group still colliding at level 2. Each level is one pass over
 * however many addresses still need resolving — three passes, full stop,
 * however many addresses or domain labels are involved. Level 3's own
 * hash length can grow in a few fixed steps (`HASH_LENGTHS`) if two
 * addresses still tie at the shortest one, but that is a bounded list
 * walked at most once, not a loop that keeps escalating on its own —
 * terminates by construction, not by observation.
 *
 * **The cross-bucket hazard is still caught.** A generated level-2 or
 * level-3 name can land on a name some *other*, already-resolved address
 * owns outright (`ada@school.edu`/`ada@gmail.com` escalating toward a name
 * a real `ada-school-edu@evil.edu` already holds bare) — checked by
 * looking up every candidate against every name already locked in from an
 * earlier pass, not only against the other members of its own original
 * group. An address that loses that check moves on to the next level
 * itself; the address that already owned the name outright is never
 * touched or forced to move.
 *
 * **What is still true, unchanged from round 2.** Two distinct addresses
 * (after the one deliberate case-insensitive merge, below) essentially
 * never end this process tied: level 3's hash is computed over the whole
 * address, not the lossy slug the two shared to get there, so two
 * genuinely different addresses produce different hashes at everyday
 * hash lengths. The one case this cannot rule out by construction — two
 * distinct addresses whose full `sha256` digest is identical — is a real
 * hash collision, astronomically unlikely and not specific to this
 * scheme; such a pair is locked in at the full digest anyway rather than
 * left unresolved, since there is nothing further this file can usefully
 * try.
 *
 * **What this deliberately does not do.** It has no memory beyond the
 * `emails` argument, and no access to the guild — so it cannot know that a
 * generated name happens to match a channel that already exists in Discord
 * for an address that is *not* in this roster (a student who left, say).
 * That is a real hazard, and it is not this function's to close: the
 * caller checks a matched channel's own ownership before treating it as
 * this row's (ROST-16, below) precisely because a name match alone is not
 * proof of ownership. Keeping that check outside this function, and this
 * function itself dependent on nothing but the roster's own set of
 * addresses, is what leaves room for ROST-17 to slot a real lookup in
 * front of it later without this function changing shape.
 */
function assignChannelNames(emails: readonly string[]): {
  /** Assigned name, keyed by the address's own lowercased, trimmed form. */
  nameByAddress: Map<string, string>
  /** Every other distinct address this address's name was disambiguated against, keyed the same way — empty for an address nothing collided with. */
  disambiguatedAgainst: Map<string, string[]>
} {
  // Case-insensitive de-duplication first: two rows for the same address,
  // spelled with different casing, are the same student and must consume
  // one name, not two — consistent with every name this function returns
  // being lowercased in the end anyway.
  const firstSpellingByAddress = new Map<string, string>()
  for (const email of emails) {
    const key = email.trim().toLowerCase()
    if (!firstSpellingByAddress.has(key)) firstSpellingByAddress.set(key, email)
  }
  const addresses = [...firstSpellingByAddress.keys()]
  const original = (address: string): string =>
    firstSpellingByAddress.get(address) ?? address

  const nameByAddress = new Map<string, string>()
  const conflictedWith = new Map<string, Set<string>>(
    addresses.map((address) => [address, new Set<string>()])
  )
  // Every name already locked in, and which address holds it — checked by
  // every later pass so a generated name can never quietly collide with an
  // address that already owns it outright (the cross-bucket hazard, this
  // function's own doc comment).
  const addressForLockedName = new Map<string, string>()

  function lock(address: string, name: string): void {
    nameByAddress.set(address, name)
    addressForLockedName.set(name, address)
  }

  function recordMutualConflict(group: readonly string[]): void {
    for (const address of group) {
      for (const other of group) {
        if (other !== address) conflictedWith.get(address)?.add(other)
      }
    }
  }

  function recordClash(group: readonly string[], owner: string): void {
    for (const address of group) {
      conflictedWith.get(address)?.add(owner)
      conflictedWith.get(owner)?.add(address)
    }
  }

  // ---- Level 1 ----
  const byLevel1 = groupBy(addresses, (address) =>
    levelOneName(original(address))
  )
  const pendingLevel2: string[] = []
  for (const [name, group] of byLevel1) {
    if (group.length === 1 && group[0] !== undefined) {
      lock(group[0], name)
    } else {
      pendingLevel2.push(...group)
      recordMutualConflict(group)
    }
  }

  // ---- Level 2 ----
  const pendingLevel3: string[] = []
  if (pendingLevel2.length > 0) {
    const byLevel2 = groupBy(pendingLevel2, (address) =>
      levelTwoName(original(address))
    )
    for (const [name, group] of byLevel2) {
      const clashOwner = addressForLockedName.get(name)
      if (
        group.length === 1 &&
        clashOwner === undefined &&
        group[0] !== undefined
      ) {
        lock(group[0], name)
      } else {
        pendingLevel3.push(...group)
        if (group.length > 1) recordMutualConflict(group)
        if (clashOwner !== undefined) recordClash(group, clashOwner)
      }
    }
  }

  // ---- Level 3 ----
  if (pendingLevel3.length > 0) {
    let remaining: string[] = pendingLevel3
    for (const hashLength of HASH_LENGTHS) {
      if (remaining.length === 0) break
      const byLevel3 = groupBy(remaining, (address) =>
        levelThreeName(original(address), hashLength)
      )
      const stillTied: string[] = []
      for (const [name, group] of byLevel3) {
        const clashOwner = addressForLockedName.get(name)
        if (
          group.length === 1 &&
          clashOwner === undefined &&
          group[0] !== undefined
        ) {
          lock(group[0], name)
        } else {
          stillTied.push(...group)
          if (group.length > 1) recordMutualConflict(group)
          if (clashOwner !== undefined) recordClash(group, clashOwner)
        }
      }
      remaining = stillTied
    }
    // Exhausted every hash length (the full 64-character `sha256` digest)
    // and still tied — this function's own doc comment has the reasoning
    // for why nothing further is attempted: locked in anyway, rather than
    // left unresolved.
    for (const address of remaining) {
      lock(address, levelThreeName(original(address), 64))
    }
  }

  const disambiguatedAgainst = new Map<string, string[]>()
  for (const address of addresses) {
    const others = [...(conflictedWith.get(address) ?? [])]
      .map((other) => original(other))
      .sort((a, b) => a.localeCompare(b))
    disambiguatedAgainst.set(address, others)
  }
  return { nameByAddress, disambiguatedAgainst }
}

/**
 * ROST-16's own escalation sequence for *one* address, independent of any
 * roster-wide collision — used only when a name match is refused because
 * it already belongs to somebody else (`channelBelongsToSomeoneElse`,
 * below), never during `assignChannelNames`' own roster-wide pass. Reuses
 * the identical three levels that function uses (`levelOneName`,
 * `levelTwoName`, `levelThreeName` across `HASH_LENGTHS`), so a fallback
 * name is never invented ad hoc — six candidates at most, a fixed list,
 * never a loop.
 */
function ownAddressCandidates(email: string): string[] {
  return [
    levelOneName(email),
    levelTwoName(email),
    ...HASH_LENGTHS.map((hashLength) => levelThreeName(email, hashLength)),
  ]
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

/**
 * ROST-16's cheap ownership guard, narrowed after round 2's must-fix 2: does
 * `channel` already grant view access to a member who was resolved for a
 * *different row of this same roster*? The first draft asked only "is this
 * grant not `member`'s own id," which was true of almost everything —
 * a teaching assistant an instructor added by hand (not on the roster at
 * all, so not evidence of anything), or *every* grant on *every* channel
 * once a row's own handle fails to resolve (`member` is `undefined`, so
 * `overwrite.id !== member?.id` is `true` unconditionally) — measured to
 * evict a renamed student from her own channel on every import, and to
 * report a hand-added TA grant as "already somebody else's." Two rows on
 * this roster genuinely competing for one channel is the only case this
 * check can actually justify, so it is the only case it looks for now:
 *
 * - An unresolved row (`member` is `undefined`) identifies no rival owner
 *   at all — it never refuses a match, full stop, whatever the channel's
 *   permissions say.
 * - A grant belonging to somebody who isn't even resolved for any row of
 *   this roster (`rosterMemberIds` does not have it) is not a rival either
 *   — a TA, a co-instructor, anyone this platform did not put there itself.
 *
 * Still heuristic, not authoritative: a channel whose true owner never
 * joined the guild (still admin-only) gives no signal either way, and two
 * *different* rosters (not two rows of the same one) coincidentally
 * generating the same name for two different real students is exactly the
 * gap ROST-17's durable person→channel record exists to close, not this
 * function.
 */
function channelBelongsToSomeoneElse(
  channel: DiscordChannel,
  member: DiscordGuildMember | undefined,
  rosterMemberIds: ReadonlySet<string>
): boolean {
  if (!member) return false
  return (channel.permissionOverwrites ?? []).some(
    (overwrite) =>
      overwrite.type === 1 &&
      overwrite.id !== member.id &&
      rosterMemberIds.has(overwrite.id) &&
      overwriteAllowsView(overwrite)
  )
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

    // SRV-10: a role named in the config but absent from the guild is
    // created, not skipped — with an empty permission bitfield of its own
    // (requirement 1), and only when `resolveRoleId` finds nothing
    // (requirement 2: a name that already resolves is used exactly as it
    // is). The created role is pushed into `roles` itself (mutated in
    // place) the same way `discord-scaffold.ts`'s own `resolveOrCreateRole`
    // does — this handler only ever resolves the one `adminsRole` name, so
    // nothing here can create it twice in the same run the way two
    // differently-cased role names could in that file, but a later reader
    // of `roles` (there is none today) inheriting a stale list would be the
    // same class of bug, and keeping the two files' role-creation logic in
    // the same shape is cheaper than explaining why one of them skips it.
    //
    // A creation failure is caught only when Discord's own response says it
    // is permanent (`DiscordRequestError.permanent` — a `403` for a bot
    // missing Manage Roles, requirement 6). A transient failure (a `429`, a
    // `5xx`, a raw transport error with no `.permanent` to consult at all)
    // is rethrown — absorbing it unconditionally used to turn a one-off
    // rate limit into a run that creates every student's channel moments
    // later missing the admins overwrite, reports `succeeded`, and can
    // never repair it afterward (this handler's own rework finding 5 makes
    // an already-present channel's *member* grant repairable on a later
    // import, but nothing repairs the admins overwrite the same way).
    const unresolvedRoles: UnresolvedRoleEntry[] = []
    const rolesCreated: string[] = []
    let adminsRoleId = resolveRoleId(roles, course.adminsRole)
    if (!adminsRoleId) {
      try {
        const created = await deps.discordRestClient.createGuildRole(
          deps.botToken,
          guildId,
          { name: course.adminsRole }
        )
        roles.push(created)
        adminsRoleId = created.id
        rolesCreated.push(course.adminsRole)
      } catch (error) {
        if (error instanceof DiscordRequestError && error.permanent) {
          unresolvedRoles.push({
            role: course.adminsRole,
            reason: describeDiscordError(error),
          })
        } else {
          throw error
        }
      }
    }

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
      channelNameDisambiguated: [],
      channelOwnershipConflicts: [],
      channelsOrphaned: [],
      unresolvedRoles,
      rolesCreated,
      limitations: [WELCOME_MESSAGE_NOT_SENT],
    }

    // ROST-14: every row's channel name, computed once from the whole
    // roster's own set of addresses — see `assignChannelNames`' own doc
    // comment for the algorithm and what it guarantees. Computed up front,
    // before any Discord call, so the name a row gets does not depend on
    // whether its own channel creation later succeeds, fails or finds no
    // room (`channelsFailed`/`channelsNotCreated` still get a stable name
    // to report against).
    const { nameByAddress, disambiguatedAgainst } = assignChannelNames(
      rows.map((row) => row.email)
    )
    // Names already spoken for by a row processed earlier in this loop —
    // ROST-16's conflict fallback (below) can push a row onto a name
    // `assignChannelNames` did not generate for it (the next candidate in
    // its own `ownAddressCandidates` sequence, once an existing channel
    // under its assigned name turns out to belong to somebody else) —
    // checked so that fallback never collides with another row's own
    // assigned or already-picked name either.
    const namesInUse = new Set(nameByAddress.values())

    // Round 3's "cheap one": every row's own handle resolution, computed
    // exactly once, up front — both `rosterMemberIds` (ROST-16's must-fix
    // 2, below) and the main loop's own per-row `member` are read from
    // this same array by index, so the two can never drift apart the way
    // two separate `resolveMember` calls risked (`resolveMember` is pure,
    // so drifting was never about correctness, only about paying for the
    // lookup twice and inviting the two call sites to quietly diverge
    // later).
    const resolutionsByRow = rows.map((row) =>
      resolveMember(row.discord, members)
    )

    // ROST-16's must-fix 2: which guild members this *roster* resolves to
    // at all — the set `channelBelongsToSomeoneElse` (below) checks a
    // conflicting grant against, so a hand-added TA (not a member any row
    // resolves to) is never mistaken for a rival student, and a row's own
    // unresolved handle never manufactures a rival out of a grant that
    // names nobody this roster recognizes.
    const rosterMemberIds = new Set(
      resolutionsByRow
        .filter(
          (
            resolution
          ): resolution is Extract<MemberResolution, { kind: 'resolved' }> =>
            resolution.kind === 'resolved'
        )
        .map((resolution) => resolution.member.id)
    )

    // Round 3's other "cheap one": defined once, referencing `categoryStates`
    // by closure, rather than redefined (and re-`flatMap`ping every
    // category) on every single row.
    const findChannelNamed = (
      name: string
    ): { channel: DiscordChannel; category: string } | undefined =>
      categoryStates
        .flatMap((state) =>
          state.channels.map((channel) => ({ channel, category: state.name }))
        )
        .find(({ channel }) => normalizeChannelName(channel.name) === name)

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex] as RosterRowWithLine
      // ---- ROST-10: person resolution, merged never overwritten (PPL-4) ----
      const resolution = resolutionsByRow[rowIndex] as MemberResolution
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

      // ---- ROST-11/ROST-12/ROST-14/ROST-16: the student's private channel ----
      const baseChannelName = channelNameForEmail(row.email)
      const addressKey = row.email.trim().toLowerCase()
      // Computed once, up front, from the whole roster — see
      // `assignChannelNames`' own doc comment. Falling back to the bare
      // name is defensive only: every row's email fed that computation, so
      // the lookup always hits.
      let channelName = nameByAddress.get(addressKey) ?? baseChannelName
      if (channelName !== baseChannelName) {
        report.channelNameDisambiguated.push({
          line: row.line,
          email: row.email,
          baseChannelName,
          channelName,
          sharesSlugWith: disambiguatedAgainst.get(addressKey) ?? [],
        })
      }

      // ROST-17: a person with a remembered channel for this course is
      // looked up by *id*, not by the name this row would derive today —
      // this file's own module comment has the full reasoning. `undefined`
      // both for a row nobody has ever remembered a channel for, and for
      // one whose remembered channel no longer exists in the guild
      // (requirement 4: recognized as gone, not trusted) — either way,
      // `remembered` alone (not `matched`) is what decides whether the
      // name-based matching and `channelBelongsToSomeoneElse` guard below
      // even run: a remembered-but-deleted channel skips straight to
      // channel creation, further down, rather than risking a name lookup
      // adopting some unrelated channel that merely happens to share
      // today's derived name.
      const remembered = rosterChannelAssignments.getChannelAssignmentForPerson(
        context.organizationId,
        course.id,
        person.id,
        context.db
      )
      let matched = remembered
        ? categoryStates
            .flatMap((state) =>
              state.channels.map((channel) => ({
                channel,
                category: state.name,
              }))
            )
            .find(({ channel }) => channel.id === remembered.discordChannelId)
        : findChannelNamed(channelName)
      if (remembered && matched) {
        // The reported name is this channel's own real, current name — not
        // whatever `assignChannelNames` would derive for this row today,
        // which is precisely what this row's channel is remembered instead
        // of re-deriving from (this file's own module comment on ROST-17).
        channelName = matched.channel.name
      }

      // ROST-16: a name match is not proof of ownership. Names can
      // legitimately drift — a student leaves and frees a bare name, an
      // address is corrected, a second `ada` joins and this row's own name
      // disambiguates out from under it (ROST-14) — and without ROST-17's
      // durable person→channel record this handler cannot yet tell "this is
      // genuinely my channel" from "this happens to be named what mine
      // would be." `channelBelongsToSomeoneElse`'s own doc comment has the
      // narrowed test (round 2's must-fix 2, re-verified sound in round 3).
      // Only reached for a row with no remembered channel at all
      // (`!remembered`) — a row whose own channel is already remembered
      // never needs this guard, and the deleted-and-recreated case above
      // never reaches this name-based path either. Requirement 3's own
      // first clause — a channel already remembered as a *different*
      // person's — is folded into the exact same escalation this guard
      // already triggers: `channelBelongsToSomeoneElse` cannot see across
      // two separate imports of two different rosters on its own (that
      // function's own doc comment names this precisely as ROST-17's gap
      // to close), so a remembered-elsewhere match escalates through the
      // same fixed candidate sequence rather than a separate refusal path.
      //
      // One deliberate carve-out on the "remembered elsewhere" half, for
      // a pre-existing identity-model gap this file's own module comment
      // documents: a row whose handle resolves to nobody gets a synthetic,
      // handle-keyed person, and a *later* import where the same handle
      // now resolves creates a second, genuinely different `people` row
      // for the same real student — nothing here reconciles the two
      // (`mergePeople` now carries a remembered channel forward on an
      // *actual* merge, `repos/people.ts`'s own doc comment; this
      // carve-out is only for the narrower case where no merge has
      // happened yet). The remembered owner must be exactly the synthetic,
      // handle-keyed person this row's own handle would resolve to had it
      // never resolved, *and* that owner's stored email must match this
      // row's own — both, not either. See D-88 (`docs/DECISIONS.md`) for
      // why: an email-only version let a departed student's channel be
      // silently reassigned to whoever the address was later reissued to;
      // a handle-identity-only version let two different real students who
      // happen to share one raw handle string across two imports inherit
      // each other's channel. The accepted cost of requiring both,
      // likewise detailed there: a row whose handle newly resolves *and*
      // whose address is corrected in the very same import escalates via
      // `channelBelongsToSomeoneElse` instead of qualifying here.
      let rememberedAsSomeoneElse = false
      if (!remembered && matched) {
        const rememberedElsewhere =
          rosterChannelAssignments.getChannelAssignmentByDiscordChannelId(
            context.organizationId,
            matched.channel.id,
            context.db
          )
        const rememberedOwner = rememberedElsewhere
          ? people.getPerson(
              context.organizationId,
              rememberedElsewhere.personId,
              context.db
            )
          : undefined
        const syntheticOwnerOfThisHandle =
          rememberedOwner !== undefined &&
          people.resolveIdentity(
            context.organizationId,
            {
              surface: 'discord' as const,
              externalId: `handle:${normalizeHandle(row.discord)}`,
            },
            context.db
          )?.id === rememberedOwner.id
        const sameStoredAddress =
          rememberedOwner !== undefined &&
          rememberedOwner.email?.trim().toLowerCase() ===
            row.email.trim().toLowerCase()
        rememberedAsSomeoneElse =
          rememberedOwner !== undefined &&
          !(syntheticOwnerOfThisHandle && sameStoredAddress)
      }

      // A refused match resumes this row's *own* `ownAddressCandidates`
      // sequence — the same fixed levels `assignChannelNames` used, one
      // level further — rather than inventing a position-based name: that
      // is what lets the *next* import of the same roster land on the
      // identical fallback name and re-adopt whatever this run created,
      // instead of creating another one on every run (round 2's must-fix
      // 3, also re-verified sound). Bounded by construction — at most six
      // fixed candidates (`ownAddressCandidates`'s own doc comment), never
      // a loop that keeps escalating on its own.
      if (
        !remembered &&
        matched &&
        (rememberedAsSomeoneElse ||
          channelBelongsToSomeoneElse(matched.channel, member, rosterMemberIds))
      ) {
        const conflictingChannelName = channelName
        const candidates = ownAddressCandidates(row.email)
        const resumeFrom = candidates.indexOf(channelName) + 1
        let resolvedCandidate: string | undefined
        let candidateMatch: ReturnType<typeof findChannelNamed>
        for (let i = Math.max(resumeFrom, 0); i < candidates.length; i++) {
          const candidate = candidates[i] as string
          if (namesInUse.has(candidate)) continue
          const existing = findChannelNamed(candidate)
          const existingRememberedElsewhere = existing
            ? rosterChannelAssignments.getChannelAssignmentByDiscordChannelId(
                context.organizationId,
                existing.channel.id,
                context.db
              )
            : undefined
          if (
            existing &&
            (existingRememberedElsewhere ||
              channelBelongsToSomeoneElse(
                existing.channel,
                member,
                rosterMemberIds
              ))
          ) {
            continue
          }
          resolvedCandidate = candidate
          candidateMatch = existing
          break
        }
        // Every one of the six fixed candidates was somehow unusable —
        // practically unreachable (the last is a full `sha256` digest of
        // this exact address, unique to it on its own) — used anyway
        // rather than left unresolved.
        channelName =
          resolvedCandidate ?? (candidates[candidates.length - 1] as string)
        namesInUse.add(channelName)
        matched = candidateMatch
        report.channelOwnershipConflicts.push({
          line: row.line,
          email: row.email,
          conflictingChannelName,
          newChannelName: channelName,
        })
      }

      if (matched) {
        // ROST-17 requirements 1/3: remembered from here on — an
        // idempotent upsert whether this channel is being adopted by name
        // for the first time, or was already remembered and is simply
        // being reconfirmed (`recordChannelAssignment`'s own doc comment).
        rosterChannelAssignments.recordChannelAssignment(
          context.organizationId,
          {
            courseId: course.id,
            personId: person.id,
            discordChannelId: matched.channel.id,
          },
          context.db
        )
        // Rework finding 5: a channel that already exists is no longer
        // frozen forever for the one student it belongs to — a handle that
        // now resolves (the student has since joined the server) gets its
        // access repaired, through the one narrowly-scoped write this
        // package makes to a channel it did not just create.
        if (member && !memberAlreadyGranted(matched.channel, member.id)) {
          try {
            await deps.discordRestClient.grantChannelMemberAccess(
              deps.botToken,
              matched.channel.id,
              member.id
            )
            // Round 2's must-fix 1 (second half): kept current in place,
            // the same way a created channel is appended to `target.channels`
            // below — without this, a later row in the *same* run that
            // checks this exact channel's ownership (`channelBelongsToSomeoneElse`)
            // would read the permission list `listGuildChannels` returned at
            // the top of this run, missing the grant this line just made.
            matched.channel.permissionOverwrites = [
              ...(matched.channel.permissionOverwrites ?? []).filter(
                (overwrite) =>
                  !(overwrite.type === 1 && overwrite.id === member.id)
              ),
              allowMemberOverwrite(member.id),
            ]
            report.channelAccessGranted.push({
              line: row.line,
              email: row.email,
              channelName,
              category: matched.category,
            })
          } catch (error) {
            report.channelAccessGrantFailed.push({
              line: row.line,
              email: row.email,
              channelName,
              category: matched.category,
              reason: describeDiscordError(error),
            })
          }
        } else {
          report.channelsAlreadyPresent.push({
            line: row.line,
            email: row.email,
            channelName,
            category: matched.category,
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

      // Round 2's honesty finding: about to *attempt* a brand-new channel —
      // if this member already has view access to some *other* channel this
      // course placed a student in, that other channel is the one this
      // student actually used, under a name this run no longer generates
      // for them (see `ChannelOrphanedEntry`'s own doc comment). Computed
      // here (before the create, so it still reads the pre-create state),
      // but not reported until the create actually succeeds, below — round
      // 3's must-fix: a failed create must not tell an instructor to go
      // reconcile a stale channel against a new one that was never made.
      const existingOwnChannel = member
        ? categoryStates
            .flatMap((state) => state.channels)
            .find((channel) => memberAlreadyGranted(channel, member.id))
        : undefined

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
        // ROST-17 requirements 1/4: remembered the moment it is created —
        // whether this is the first channel this person has ever had for
        // this course, or the replacement for one that was remembered and
        // has since been deleted from the server
        // (`recordChannelAssignment`'s own upsert lands on the same row
        // either way).
        rosterChannelAssignments.recordChannelAssignment(
          context.organizationId,
          {
            courseId: course.id,
            personId: person.id,
            discordChannelId: created.id,
          },
          context.db
        )
        report.channelsCreated.push({
          line: row.line,
          email: row.email,
          channelName: created.name,
          category: target.name,
        })
        if (existingOwnChannel) {
          report.channelsOrphaned.push({
            line: row.line,
            email: row.email,
            previousChannelName: existingOwnChannel.name,
            newChannelName: created.name,
          })
        }
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
