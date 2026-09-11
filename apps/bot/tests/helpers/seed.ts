/**
 * Test helper: an organization with a Discord server bound to it (TEN-3,
 * SURF-3) and one enabled course (PROJ-1) — the smallest graph
 * `runCatchUp`/`handleMention` need to route and answer a message.
 * Duplicated from `packages/discord/tests/helpers/seed.ts` rather than
 * imported across a package boundary test helpers are not published
 * through.
 */

import { randomUUID } from 'node:crypto'

import {
  accounts,
  courses,
  discordServers,
  organizations,
  people,
  projects,
  type Database,
} from '@bloombot/db'

/** Matches `apps/bot/tests/helpers/fake-discord.ts#fakeMessage`'s own default `authorId`, the same way `packages/discord/tests/helpers/fixtures.ts#DEFAULT_AUTHOR_ID` matches that package's own default. */
export const DEFAULT_AUTHOR_ID = 'author-1'

export interface SeedResult {
  organizationId: string
  courseId: string
  /** The Discord server (guild) snowflake bound to `organizationId`. */
  guildId: string
}

export interface SeedOptions {
  categoryName?: string
  adminsRole?: string
  studentsRole?: string
  enabled?: boolean
  promptId?: string | null
  instructions?: string | null
  /** LINK-1 — connect a person under `DEFAULT_AUTHOR_ID` by default, so an ordinary "answer" test does not also have to reason about LINK-1's own connect invitation. `false` for a test that specifically wants an unconnected author. */
  connectDefaultAuthor?: boolean
}

/** One organization, one Discord server bound to it, and one enabled course with a single category. */
export function seedBoundServerWithCourse(
  db: Database,
  options: SeedOptions = {}
): SeedResult {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    db
  )

  const installer = accounts.createAccount(
    organizationId,
    { email: 'admin@example.edu', displayName: 'Admin', role: 'owner' },
    db
  )

  const guildId = randomUUID()
  discordServers.claimDiscordServerBinding(
    organizationId,
    { serverId: guildId, installedByAccountId: installer.id },
    db
  )

  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )

  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      enabled: options.enabled ?? true,
      adminsRole: options.adminsRole ?? 'admins-tc',
      studentsRole: options.studentsRole ?? 'students-tc',
      maxRequestsPerDay: 10,
      promptId: options.promptId ?? null,
      instructions:
        options.instructions === undefined
          ? 'Be helpful.'
          : options.instructions,
      selfEnrolFromDiscord: false,
      answerUnenrolled: true,
      categories: [
        { name: options.categoryName ?? 'Test Category', channels: [] },
      ],
    },
    db
  )
  if (!courseResult.ok) {
    throw new Error(
      `seedBoundServerWithCourse: failed to create course: ${courseResult.conflict.message}`
    )
  }

  // LINK-1 — connected the same way a real proof would
  // (`@bloombot/auth`'s `person-link.ts`): resolving a Discord identity,
  // then merging a second (throwaway) identity onto it, which is what
  // actually sets `connectedAt`.
  if (options.connectDefaultAuthor ?? true) {
    const discordPerson = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: DEFAULT_AUTHOR_ID },
      db
    )
    const other = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'web', externalId: `seed-web-${randomUUID()}` },
      db
    )
    const merged = people.mergePeople(
      organizationId,
      discordPerson.id,
      other.id,
      db
    )
    if (!merged) {
      throw new Error(
        'seedBoundServerWithCourse: failed to connect the default author'
      )
    }
  }

  return { organizationId, courseId: courseResult.course.id, guildId }
}
