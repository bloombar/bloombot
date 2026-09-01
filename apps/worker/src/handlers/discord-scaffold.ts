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
 * does not police it either).
 *
 * SRV-8's "never delete" is structural, not a rule this file remembers to
 * follow: `DiscordRestClient` (`packages/discord-rest/src/client.ts`) has no
 * method that edits or removes a category or channel at all, so there is
 * nothing here to call even for a guild holding a category or channel the
 * course no longer declares — `undeclaredCategories` in the report below is
 * exactly that: named, never touched.
 */

import { courses, discordServers } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import {
  allowRoleOverwrite,
  denyEveryoneOverwrite,
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
  adminsOnly: boolean
}

export interface ScaffoldCategoryReport {
  name: string
  status: 'created' | 'already_present'
  channels: ScaffoldChannelReport[]
}

/** SRV-6..8's own report — what `@bloombot/actions`' `jobs.get` read action hands back once a scaffold job succeeds. */
export interface ScaffoldReport {
  courseId: string
  guildId: string
  categories: ScaffoldCategoryReport[]
  /** A category present in the guild that this course does not declare (SRV-8) — reported, never removed. */
  undeclaredCategories: string[]
  /** A course role name (`adminsRole`/`studentsRole`) that did not resolve to a role in the guild (SRV-2's "skipped rather than treated as fatal") — reported instead of guessed at. */
  unresolvedRoles: string[]
}

/** Case- and whitespace-insensitive name matching — `discord_manager.py`'s own `.lower().strip()` comparison, carried over so a category or channel named identically but for casing is recognised as the same one. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
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

    const binding = discordServers.getActiveDiscordServerBindingForOrganization(
      context.organizationId,
      context.db
    )
    if (!binding) {
      throw new Error(
        `discordServers.scaffold: organization "${context.organizationId}" has no single active Discord server bound`
      )
    }
    const guildId = binding.serverId

    const [existingChannels, roles] = await Promise.all([
      deps.discordRestClient.listGuildChannels(deps.botToken, guildId),
      deps.discordRestClient.listGuildRoles(deps.botToken, guildId),
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
    const categoryOverwrites: DiscordPermissionOverwrite[] = [
      everyoneOverwrite,
      ...(adminsRoleId ? [allowRoleOverwrite(adminsRoleId)] : []),
      ...(studentsRoleId ? [allowRoleOverwrite(studentsRoleId)] : []),
    ]
    const adminsOnlyOverwrites: DiscordPermissionOverwrite[] = [
      everyoneOverwrite,
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
      if (existingCategory) {
        categoryId = existingCategory.id
        categoryStatus = 'already_present'
      } else {
        const created: DiscordChannel =
          await deps.discordRestClient.createGuildCategory(
            deps.botToken,
            guildId,
            { name: category.name, permissionOverwrites: categoryOverwrites }
          )
        categoryId = created.id
        categoryStatus = 'created'
        guildCategories = [...guildCategories, created]
      }

      const channelReports: ScaffoldChannelReport[] = []
      for (const channel of declaredChannels(category)) {
        const existingChannel = guildChannels.find(
          (candidate) =>
            candidate.parentId === categoryId &&
            normalizeName(candidate.name) === normalizeName(channel.name)
        )
        if (existingChannel) {
          channelReports.push({
            name: channel.name,
            status: 'already_present',
            adminsOnly: channel.adminsOnly,
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
        })
      }

      categoryReports.push({
        name: category.name,
        status: categoryStatus,
        channels: channelReports,
      })
    }

    // SRV-8: named, never removed.
    const declaredCategoryNames = new Set(
      course.categories.map((category) => normalizeName(category.name))
    )
    const undeclaredCategories = guildCategories
      .filter(
        (channel) => !declaredCategoryNames.has(normalizeName(channel.name))
      )
      .map((channel) => channel.name)

    return {
      courseId: course.id,
      guildId,
      categories: categoryReports,
      undeclaredCategories,
      unresolvedRoles,
    }
  }
}
