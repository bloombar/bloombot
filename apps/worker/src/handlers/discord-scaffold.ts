/**
 * The `discordServers.scaffold` job handler (SRV-6..8) — this platform's
 * `hydrate_server.py`, moved behind the queue the previous slice built, and
 * the first real handler `apps/worker` registers (its own module comment,
 * before this slice, said none was — see `index.ts`).
 *
 * `createDiscordScaffoldHandler` closes over the two dependencies a job
 * handler cannot get from `JobContext` (`@bloombot/jobs`'s own registry.ts)
 * — a `DiscordRestClient` and the bot token every guild-management call
 * needs — the same factory shape `@bloombot/openai`'s
 * `createOpenAiModelClient` already uses for its own closed-over API key.
 *
 * SRV-7's idempotence: every category and channel this handler creates is
 * matched against the guild's existing ones *by name* (case- and
 * whitespace-insensitive, the same normalization `discord_manager.py`'s own
 * `get_category_id`/`get_channel_id` already apply) before it creates
 * anything — what already exists is left alone, what is missing is
 * created, and the returned `ScaffoldReport` names both. Two categories (or
 * two channels in the same category) that share a name after that
 * normalization are indistinguishable to this match — the first one found
 * wins, and the second is treated as "already present" even though it is a
 * different row; `docs/DECISIONS.md` has the fuller reasoning for why this
 * is an acceptable simplification for this slice rather than a bug to
 * chase (a course's own categories are named by an instructor who has every
 * reason not to reuse a name, and the platform's own `courses.save` action
 * does not police it either). A *channel*'s own name needs one more
 * transform before that comparison: Discord silently slugs a `GUILD_TEXT`
 * channel's name at creation (lowercases it, collapses whitespace to `-`),
 * so a declared `general chat` comes back from the guild as `general-chat`
 * — `normalizeChannelName`, below, applies that same transform to both
 * sides before comparing, which `normalizeName` alone does not (finding 1 of
 * the SRV-6..8 rework). Categories are not slugged this way and keep using
 * `normalizeName`.
 *
 * SRV-8's "never delete" is structural, not a rule this file remembers to
 * follow: `DiscordRestClient` (`packages/discord-rest/src/client.ts`) has no
 * method that edits or removes a category or channel at all, so there is
 * nothing here to call even for a guild holding a category or channel the
 * course no longer declares — `undeclaredCategories`/`undeclaredChannels` in
 * the report below are exactly that: named, never touched. Both are diffed
 * against every course *this organization* declares, not only the one being
 * scaffolded (finding 2/3 of the rework) — a guild can host more than one
 * course at once (one Discord server binding per organization, courses
 * spread across its projects), so diffing against a single course's own
 * declarations reported every other course's categories and channels as
 * undeclared, which is precisely the "hand-delete a live course's channels"
 * outcome SRV-8 exists to prevent.
 *
 * SRV-9 is the one deliberate exception to that structural no-edit, and it
 * is narrow on purpose: a course category denies `@everyone`, and Discord
 * applies that denial to the bot too unless it is missing from a category's
 * or channel's own overwrites — so an `already_present` category or channel
 * this run adopts gets a single `PUT /channels/{id}/permissions/{botId}`
 * whenever the bot is missing there, and nowhere else. That repair applies
 * one level deeper than it first shipped: an `already_present` *category*
 * missing the bot has been repaired since `allowBotOverwrite` existed
 * (below), but an `already_present` *channel* with its own overwrites
 * (Discord copies a category's overwrites into a channel at creation, then
 * stops syncing them the moment the channel gets any of its own) did not
 * inherit that fix and stayed silently unreachable — D-51 has the fuller
 * reasoning, including why a channel with *no* overwrites of its own is
 * left alone entirely (it already inherits the category's, repair
 * included, and writing to it would only desync it from the category in
 * Discord's UI).
 *
 * A category or channel this run finds `already_present` never had any
 * *other* permission written by this run (SRV-8's structural no-edit,
 * SRV-9's one exception above) — so
 * `ScaffoldCategoryReport.everyoneDenied`/`ScaffoldChannelReport.adminsOnly`
 * for one of those is *read* from Discord's own response (including the
 * bot's own repair, if this run made one), not copied from what the course
 * declares, and `establishedByThisRun: false` says so (finding 4 of the
 * rework). See `docs/DECISIONS.md` for what a wrong observed value means
 * for an instructor, given this package's structural inability to fix it.
 */

import { courses, discordServers, type Database } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import {
  allowBotOverwrite,
  allowRoleOverwrite,
  denyEveryoneOverwrite,
  overwriteAllowsView,
  overwriteDeniesView,
  type DiscordChannel,
  type DiscordPermissionOverwrite,
  type DiscordRestClient,
} from '@bloombot/discord-rest'

type CourseWithCategories = NonNullable<ReturnType<typeof courses.getCourse>>
type CourseCategoryWithChannels = CourseWithCategories['categories'][number]

/** Discord's own channel-type enum (API v10) — the one value this handler needs to tell a category apart from a text channel in `listGuildChannels`' own flat list. */
const CHANNEL_TYPE_GUILD_CATEGORY = 4

/** SRV-4's placeholder — a bare category (a plain string in the YAML this table mirrors, per `schema.ts`'s own `courseCategories` comment) declares no channels of its own, so it gets exactly one, named `temp`, to keep Discord from hiding an empty category. */
const PLACEHOLDER_CHANNEL_NAME = 'temp'

/**
 * The job `kind` this handler is registered under (`index.ts`), and the one
 * `@bloombot/actions`' `discordServers.scaffold` action enqueues
 * (`packages/actions/src/actions/discord-servers.ts`) — the two packages
 * cannot share this as an import (an app does not import from another app,
 * and a package does not depend on `apps/worker`), so it is a literal
 * string in both places, matched by this comment cross-referencing the
 * other rather than a shared constant.
 */
export const DISCORD_SCAFFOLD_JOB_KIND = 'discordServers.scaffold'

export interface DiscordScaffoldHandlerDependencies {
  discordRestClient: DiscordRestClient
  /** The same bot token `apps/bot`'s own gateway connection uses — this handler reaches Discord over REST with it (this file's own module comment), never a gateway connection of its own. */
  botToken: string
}

export interface ScaffoldChannelReport {
  name: string
  status: 'created' | 'already_present'
  /**
   * Whether this channel is actually admins-only right now. For `status:
   * 'created'` this is exactly what this run just requested (SRV-3) — a
   * fact, not an observation. For `status: 'already_present'` this run wrote
   * nothing (SRV-8), so it is read from the channel's own overwrites
   * instead, falling back to its category's cascade for a channel with none
   * of its own — see `channelIsAdminsOnly`, below. Finding 4 of the SRV-6..8
   * rework: this used to be copied from the *declaration* regardless of
   * status, so an instructor who set `admins_only: true` on a channel
   * students could already read was told `adminsOnly: true` even though
   * nothing had changed.
   */
  adminsOnly: boolean
  /** `true` only for `status: 'created'` — whether `adminsOnly` above is a permission state this run actually set, or merely one it observed on a pre-existing channel it never wrote to. See this file's own module comment and `docs/DECISIONS.md`. */
  establishedByThisRun: boolean
  /**
   * SRV-9's own field, distinct from `establishedByThisRun` above: `true`
   * only for `status: 'already_present'`, and only when this run found the
   * bot missing from *this channel's own* overwrites and wrote it a single
   * `PUT /channels/{id}/permissions/{id}` to fix that (D-51) — the channel
   * half of the same repair `already_present` categories have had since
   * `allowBotOverwrite`. `false` for a channel that inherits its category's
   * overwrites (nothing of its own to be missing the bot from) and for one
   * that already named the bot, so an instructor can tell "I just fixed
   * this" from "this was already fine" instead of both collapsing into
   * `already_present`.
   */
  accessRepaired: boolean
}

export interface ScaffoldCategoryReport {
  name: string
  status: 'created' | 'already_present'
  /**
   * Whether `@everyone` is actually denied view access on this category
   * right now — `true` unconditionally for `status: 'created'` (SRV-2 always
   * denies it at creation), read from the category's own overwrites for
   * `status: 'already_present'`, the same "observe, do not assume" fix as
   * `ScaffoldChannelReport.adminsOnly` (finding 4 of the SRV-6..8 rework): a
   * pre-existing, still-public category is never locked down by this run,
   * and every channel created inside it inherits that openness whether or
   * not this field says so honestly.
   */
  everyoneDenied: boolean
  /** `true` only for `status: 'created'` — see `ScaffoldChannelReport.establishedByThisRun`. */
  establishedByThisRun: boolean
  channels: ScaffoldChannelReport[]
}

/** SRV-6..8's own report — what `@bloombot/actions`' `jobs.get` read action hands back once a scaffold job succeeds. */
export interface ScaffoldReport {
  courseId: string
  guildId: string
  categories: ScaffoldCategoryReport[]
  /** A category present in the guild that no course in this organization declares (SRV-8, finding 2 of the rework) — reported, never removed. */
  undeclaredCategories: string[]
  /** A channel present in a *declared* category that no course in this organization declares (SRV-8, finding 3 of the rework) — a category the organization does not declare at all is already covered by naming the category itself, above; this only names a channel one level inside a category that is still recognised. Reported, never removed. */
  undeclaredChannels: string[]
  /** A course role name (`adminsRole`/`studentsRole`) that did not resolve to a role in the guild (SRV-2's "skipped rather than treated as fatal") — reported instead of guessed at. */
  unresolvedRoles: string[]
}

/** Case- and whitespace-insensitive name matching — `discord_manager.py`'s own `.lower().strip()` comparison, carried over so a *category* named identically but for casing is recognised as the same one. Not used for a channel's own name — see `normalizeChannelName`, below, and this file's own module comment. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Finding 1 of the SRV-6..8 rework: Discord slugs a `GUILD_TEXT` channel's
 * own name at creation time — lowercases it and collapses each run of
 * whitespace to a single `-` — silently, with no way to opt out through the
 * API. A declared channel named `general chat` therefore comes back from
 * `listGuildChannels` as `general-chat`, never `general chat`; comparing a
 * declared name against the guild's own by `normalizeName` alone (case and
 * whitespace only) never matches it, so every scaffold run after the first
 * created a fresh duplicate — SRV-7 broken on the first channel name with a
 * space in it. Applying this same transform to *both* sides of a channel
 * name comparison before normalizing is what fixes that: a declared `general
 * chat` and a guild's own `general-chat` compare equal. `GUILD_CATEGORY`
 * names are not slugged this way — Discord stores and returns a category's
 * name verbatim but for case/whitespace, so categories keep using
 * `normalizeName` above.
 */
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

function parsePayload(raw: unknown): { courseId: string } {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { courseId?: unknown }).courseId !== 'string'
  ) {
    throw new Error(
      'discordServers.scaffold: payload must be an object shaped { courseId: string }'
    )
  }
  return { courseId: (raw as { courseId: string }).courseId }
}

/** A category the course declares as a bare string has no `channels` of its own — SRV-4 fills that in with the one placeholder channel, so the create loop below never has to special-case an empty list. */
function declaredChannels(
  category: CourseCategoryWithChannels
): { name: string; adminsOnly: boolean }[] {
  if (category.channels.length > 0) return category.channels
  return [{ name: PLACEHOLDER_CHANNEL_NAME, adminsOnly: false }]
}

/** Every category name, and every channel name within it, every course in `organizationId` declares — the diff base for `undeclaredCategories`/`undeclaredChannels` (finding 2/3 of the SRV-6..8 rework, this file's own module comment). Deliberately every course, not only enabled ones in a non-archived project: PROJ-3's name-uniqueness guarantee only covers those, so a disabled or archived-project course could still share a name with something real on the guild, and treating it as undeclared risks exactly the false positive — reporting a live course's own category as safe to delete — this fix exists to remove. Under-reporting a genuinely stale leftover is the direction it is safe to err in; over-reporting a live course's own category is not. */
function loadOrganizationDeclaredNames(
  organizationId: string,
  db: Database
): {
  categoryNames: Set<string>
  channelNamesByCategory: Map<string, Set<string>>
} {
  const categoryNames = new Set<string>()
  const channelNamesByCategory = new Map<string, Set<string>>()

  for (const courseRow of courses.listCourses(organizationId, db)) {
    const fullCourse = courses.getCourse(organizationId, courseRow.id, db)
    if (!fullCourse) continue // Deleted between the list and this read — nothing left to declare.

    for (const category of fullCourse.categories) {
      const normalizedCategory = normalizeName(category.name)
      categoryNames.add(normalizedCategory)
      const channelNames =
        channelNamesByCategory.get(normalizedCategory) ?? new Set<string>()
      for (const channel of declaredChannels(category)) {
        channelNames.add(normalizeChannelName(channel.name))
      }
      channelNamesByCategory.set(normalizedCategory, channelNames)
    }
  }

  return { categoryNames, channelNamesByCategory }
}

/**
 * Whether `@everyone` is actually denied view access on `overwrites` right
 * now, read directly rather than assumed (finding 4 of the SRV-6..8
 * rework). `overwrites` comes straight from Discord's own response
 * (`DiscordChannel.permissionOverwrites`) — `[]` when Discord did not carry
 * usable overwrites at all, which this correctly treats as "not denied"
 * (Discord's own default is that `@everyone` *can* see a channel unless
 * something says otherwise).
 */
function everyoneIsDenied(
  overwrites: DiscordPermissionOverwrite[],
  guildId: string
): boolean {
  const everyoneOverwrite = overwrites.find((entry) => entry.id === guildId)
  return (
    everyoneOverwrite !== undefined && overwriteDeniesView(everyoneOverwrite)
  )
}

/**
 * Whether a channel is actually admins-only right now (finding 4 of the
 * SRV-6..8 rework) — read from `channelOverwrites` (the channel's own) when
 * it has any, since an explicit overwrite for `@everyone`/the students role
 * on the channel itself always decides it regardless of its category.
 * A channel with none of its own (SRV-3's "omitted entirely... the channel
 * then inherits its category's" — `client.ts`'s own `createGuildChannel` doc
 * comment) falls back to `categoryOverwrites` — the same cascade Discord
 * itself applies, one level deep, which is as deep as this platform's own
 * category/channel nesting ever goes.
 */
function channelIsAdminsOnly(
  channelOverwrites: DiscordPermissionOverwrite[],
  categoryOverwrites: DiscordPermissionOverwrite[],
  studentsRoleId: string | undefined,
  guildId: string
): boolean {
  const overwrites =
    channelOverwrites.length > 0 ? channelOverwrites : categoryOverwrites

  // The students role, explicitly granted or denied view on `overwrites`,
  // always settles it — an admin-only channel/category never grants it.
  if (studentsRoleId) {
    const studentOverwrite = overwrites.find(
      (entry) => entry.id === studentsRoleId
    )
    if (studentOverwrite) return !overwriteAllowsView(studentOverwrite)
  }

  // No resolved students role, or no overwrite naming it: whether
  // `@everyone` itself is denied is the only signal left.
  return everyoneIsDenied(overwrites, guildId)
}

/**
 * Runs one course's scaffold. Loads the course and its bound guild through
 * the usual organization-scoped repo functions (TEN-2) — a payload naming
 * another organization's course resolves to nothing here exactly as it does
 * anywhere else in the platform (`packages/db/src/repos/jobs.ts`'s own
 * module comment has the general case), refusing the whole job rather than
 * reaching across a tenant boundary.
 *
 * A Discord call that fails mid-run (a rate limit, a transport error, the
 * guild becoming unreachable) simply throws out of this function — JOB-2's
 * ordinary retry/backoff takes it from there, and this handler's own
 * match-by-name idempotence (SRV-7) is exactly what makes that safe to
 * retry: whatever categories or channels the failed attempt already
 * created are found "already present" on the next attempt rather than
 * recreated. See `docs/DECISIONS.md` for the fuller reasoning, including
 * what a fired `JOB_HANDLER_TIMEOUT_MS` means for a call still in flight
 * underneath it (`packages/jobs/src/runner.ts`'s own module comment).
 */
export function createDiscordScaffoldHandler(
  deps: DiscordScaffoldHandlerDependencies
): JobHandler {
  return async (
    rawPayload: unknown,
    context: JobContext
  ): Promise<ScaffoldReport> => {
    const payload = parsePayload(rawPayload)

    const course: CourseWithCategories | undefined = courses.getCourse(
      context.organizationId,
      payload.courseId,
      context.db
    )
    if (!course) {
      throw new Error(
        `discordServers.scaffold: course "${payload.courseId}" was not found in this organization`
      )
    }

    // TEN-9 — the guild this course scaffolds into is resolved through the
    // course's *own* server, not "the organization's one binding": an
    // organization holding two or more active bindings is an ordinary case
    // now, not the edge case this handler used to refuse identically to
    // "none bound" (`getActiveDiscordServerBindingForOrganization`'s own
    // module comment, before this slice). `resolveCourseDiscordServer`'s
    // three outcomes each get their own message so an instructor reading
    // the job's failure can tell them apart.
    const serverResolution = discordServers.resolveCourseDiscordServer(
      context.organizationId,
      course.discordServerId,
      context.db
    )
    if (!serverResolution.ok) {
      throw new Error(
        serverResolution.reason === 'ambiguous'
          ? `discordServers.scaffold: organization "${context.organizationId}" has more than one active Discord server, and course "${course.id}" does not say which one it routes in`
          : `discordServers.scaffold: course "${course.id}" is bound to a Discord server that is no longer active`
      )
    }
    if (!serverResolution.binding) {
      throw new Error(
        `discordServers.scaffold: organization "${context.organizationId}" has no active Discord server bound`
      )
    }
    const guildId = serverResolution.binding.serverId

    const [existingChannels, roles, botUserId] = await Promise.all([
      deps.discordRestClient.listGuildChannels(deps.botToken, guildId),
      deps.discordRestClient.listGuildRoles(deps.botToken, guildId),
      deps.discordRestClient.getBotUserId(deps.botToken),
    ])

    // SRV-2: a role named in the config but absent from the guild is
    // skipped, not fatal — reported in `unresolvedRoles` instead.
    const unresolvedRoles: string[] = []
    const adminsRoleId = resolveRoleId(roles, course.adminsRole)
    if (!adminsRoleId) unresolvedRoles.push(course.adminsRole)
    const studentsRoleId = resolveRoleId(roles, course.studentsRole)
    if (!studentsRoleId) unresolvedRoles.push(course.studentsRole)

    // Discord's own `@everyone` role shares its guild's id (`channel-overwrites.ts`'s
    // own doc comment) — nothing to resolve for it.
    const everyoneOverwrite = denyEveryoneOverwrite(guildId)
    // The bot grants itself access to every category it closes to
    // `@everyone`. Without this the run locks itself out: Discord applies the
    // `@everyone` view denial to the bot too (unless it is an Administrator),
    // so the category is created and then every `createGuildChannel` inside
    // it comes back `403` — observed in the field, and the reason
    // `allowBotOverwrite` exists.
    const botOverwrite = allowBotOverwrite(botUserId)
    const categoryOverwrites: DiscordPermissionOverwrite[] = [
      everyoneOverwrite,
      botOverwrite,
      ...(adminsRoleId ? [allowRoleOverwrite(adminsRoleId)] : []),
      ...(studentsRoleId ? [allowRoleOverwrite(studentsRoleId)] : []),
    ]
    const adminsOnlyOverwrites: DiscordPermissionOverwrite[] = [
      everyoneOverwrite,
      botOverwrite,
      ...(adminsRoleId ? [allowRoleOverwrite(adminsRoleId)] : []),
    ]

    // Mutated locally as this run creates categories/channels, so a course
    // declaring the same name twice (or a bare category's own placeholder
    // colliding with a later real channel of the same name) still matches
    // against what this very run has already created, not only what the
    // guild held when the run started.
    let guildCategories = existingChannels.filter(
      (channel) => channel.type === CHANNEL_TYPE_GUILD_CATEGORY
    )
    let guildChannels = existingChannels.filter(
      (channel) => channel.type !== CHANNEL_TYPE_GUILD_CATEGORY
    )

    const categoryReports: ScaffoldCategoryReport[] = []

    for (const category of course.categories) {
      const existingCategory = guildCategories.find(
        (channel) =>
          normalizeName(channel.name) === normalizeName(category.name)
      )

      let categoryId: string
      let categoryStatus: 'created' | 'already_present'
      // What this run knows the category's overwrites actually are, used
      // both for the report below and as the channel loop's own fallback
      // for a channel with no overwrites of its own (finding 4 of the
      // rework). For `created`, this is `categoryOverwrites` itself — what
      // this run just requested, known accurate regardless of how faithfully
      // Discord's create response happens to echo it back. For
      // `already_present`, this run wrote nothing, so it is read from the
      // existing row instead.
      let categoryOverwritesObserved: DiscordPermissionOverwrite[]
      if (existingCategory) {
        categoryId = existingCategory.id
        categoryStatus = 'already_present'
        categoryOverwritesObserved = existingCategory.permissionOverwrites ?? []

        // Repair the one overwrite this run cannot work without.
        //
        // A category created before the bot granted itself access — every
        // category any earlier version of this handler made — denies
        // `@everyone` and names the bot nowhere, so Discord refuses the very
        // next `createGuildChannel` inside it with a `403`. Adopting such a
        // category unchanged fails identically on every future run, which is
        // exactly what happened in the field.
        //
        // This is not a general "make the guild match the config" rewrite,
        // which SRV-8 and this file's observe-rather-than-assume discipline
        // both rule out: `PUT /channels/{id}/permissions/{id}` replaces one
        // target's entry and leaves every other alone, so the course's own
        // admins and students grants, its `@everyone` denial, and anything an
        // instructor added by hand all survive untouched. The only thing that
        // changes is whether the bot can act inside a category it owns.
        const botAlreadyGranted = categoryOverwritesObserved.some(
          (entry) => entry.id === botUserId
        )
        if (!botAlreadyGranted) {
          await deps.discordRestClient.grantBotChannelAccess(
            deps.botToken,
            categoryId,
            botUserId
          )
          categoryOverwritesObserved = [
            ...categoryOverwritesObserved,
            botOverwrite,
          ]
        }
      } else {
        const created: DiscordChannel =
          await deps.discordRestClient.createGuildCategory(
            deps.botToken,
            guildId,
            { name: category.name, permissionOverwrites: categoryOverwrites }
          )
        categoryId = created.id
        categoryStatus = 'created'
        categoryOverwritesObserved = categoryOverwrites
        guildCategories = [...guildCategories, created]
      }

      const channelReports: ScaffoldChannelReport[] = []
      for (const channel of declaredChannels(category)) {
        const existingChannel = guildChannels.find(
          (candidate) =>
            candidate.parentId === categoryId &&
            normalizeChannelName(candidate.name) ===
              normalizeChannelName(channel.name)
        )
        if (existingChannel) {
          // SRV-9's channel half. Discord copies a category's own overwrites
          // into a channel at creation time, but stops syncing them the
          // moment the channel gets any of its own — so an instructor who
          // hand-made a channel before its category was repaired (or a
          // channel this handler itself made admins-only, before
          // `allowBotOverwrite` existed) holds a snapshot that never picks
          // up the category's own repair. `channelOverwritesObserved.length
          // === 0` is exactly "this channel has none of its own", the same
          // fallback `channelIsAdminsOnly` already reasons about below —
          // that channel inherits the category's overwrites (including,
          // now, the bot's) through Discord's own cascade, so writing here
          // would be redundant *and* would desync it from its category in
          // Discord's UI, a real cost to an instructor managing permissions
          // at the category level. Only a channel with its own overwrites
          // that omit the bot gets the single repair `PUT`.
          const channelOverwritesObserved =
            existingChannel.permissionOverwrites ?? []
          const botAlreadyGrantedOnChannel = channelOverwritesObserved.some(
            (entry) => entry.id === botUserId
          )
          const accessRepaired =
            channelOverwritesObserved.length > 0 && !botAlreadyGrantedOnChannel
          if (accessRepaired) {
            // The same single-target `PUT` the category repair above uses —
            // it replaces only the bot's own entry, so every role grant, any
            // per-member permission an instructor added by hand, and the
            // `@everyone` denial that makes an admins-only channel
            // admins-only all survive untouched.
            await deps.discordRestClient.grantBotChannelAccess(
              deps.botToken,
              existingChannel.id,
              botUserId
            )
          }
          channelReports.push({
            name: channel.name,
            status: 'already_present',
            // Finding 4 of the rework: read, not copied from the
            // declaration — this run wrote nothing to an existing channel's
            // *other* permissions (SRV-8). Computed from what this run now
            // knows the channel's overwrites actually are, so the repair
            // above (if it happened) is reflected here too.
            adminsOnly: channelIsAdminsOnly(
              accessRepaired
                ? [...channelOverwritesObserved, botOverwrite]
                : channelOverwritesObserved,
              categoryOverwritesObserved,
              studentsRoleId,
              guildId
            ),
            establishedByThisRun: false,
            accessRepaired,
          })
          continue
        }

        const created = await deps.discordRestClient.createGuildChannel(
          deps.botToken,
          guildId,
          {
            name: channel.name,
            parentId: categoryId,
            // SRV-3: an admins-only channel gets its own overwrite; every
            // other channel is created with none at all, so it inherits its
            // category's through Discord's own permission cascade
            // (`createGuildChannel`'s own doc comment in `client.ts`).
            ...(channel.adminsOnly
              ? { permissionOverwrites: adminsOnlyOverwrites }
              : {}),
          }
        )
        guildChannels = [...guildChannels, created]
        channelReports.push({
          name: channel.name,
          status: 'created',
          adminsOnly: channel.adminsOnly,
          establishedByThisRun: true,
          // Not a repair — this run created the channel with the bot's own
          // overwrite already baked in where it needs one (an admins-only
          // channel's own `adminsOnlyOverwrites`) or inheriting the
          // category's (every other channel), never adopting one missing it.
          accessRepaired: false,
        })
      }

      categoryReports.push({
        name: category.name,
        status: categoryStatus,
        everyoneDenied:
          categoryStatus === 'created'
            ? true // SRV-2 always denies it at creation — a fact, not an observation.
            : everyoneIsDenied(categoryOverwritesObserved, guildId),
        establishedByThisRun: categoryStatus === 'created',
        channels: channelReports,
      })
    }

    // SRV-8, finding 2/3 of the rework: named, never removed, diffed against
    // every course this organization declares — not only the one being
    // scaffolded. See this file's own module comment and
    // `loadOrganizationDeclaredNames` for why.
    const declaredNames = loadOrganizationDeclaredNames(
      context.organizationId,
      context.db
    )
    const undeclaredCategories = guildCategories
      .filter(
        (channel) =>
          !declaredNames.categoryNames.has(normalizeName(channel.name))
      )
      .map((channel) => channel.name)

    // Finding 3 of the rework: a channel inside a category the organization
    // *does* declare, whose own name no course lists any more. Scoped to
    // declared categories only — an undeclared category's own channels are
    // already covered by naming the category itself, above; naming them too
    // would just be noise on top of a category a human is already looking
    // at.
    const undeclaredChannels = guildCategories
      .filter((category) =>
        declaredNames.categoryNames.has(normalizeName(category.name))
      )
      .flatMap((category) => {
        const declaredChannelNames =
          declaredNames.channelNamesByCategory.get(
            normalizeName(category.name)
          ) ?? new Set<string>()
        return guildChannels
          .filter((channel) => channel.parentId === category.id)
          .filter(
            (channel) =>
              !declaredChannelNames.has(normalizeChannelName(channel.name))
          )
          .map((channel) => channel.name)
      })

    return {
      courseId: course.id,
      guildId,
      categories: categoryReports,
      undeclaredCategories,
      undeclaredChannels,
      unresolvedRoles,
    }
  }
}
