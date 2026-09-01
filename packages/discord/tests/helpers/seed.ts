/**
 * Test helper: an organization with a Discord server bound to it (TEN-3,
 * SURF-3) and one enabled course (PROJ-1) — the smallest graph
 * `handleMention` needs to route and answer a message. Written through
 * `@bloombot/db`'s own repos, never raw SQL, the same convention
 * `packages/core/tests/helpers/seed.ts` holds itself to.
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

import { DEFAULT_AUTHOR_ID } from './fixtures.js'

export interface SeedResult {
  organizationId: string
  courseId: string
  /** The Discord server (guild) snowflake bound to `organizationId` — the value a test's `InboundMention.guildId` should carry. */
  guildId: string
}

export interface SeedOptions {
  maxRequestsPerDay?: number | null
  promptId?: string | null
  instructions?: string | null
  categoryName?: string
  adminsRole?: string
  studentsRole?: string
  enabled?: boolean
  /**
   * LINK-1 — connect a person under `fixtures.ts#DEFAULT_AUTHOR_ID` by
   * default, so the great majority of this suite's tests (which use
   * `inboundMention`'s own default `authorId` and were written before
   * LINK-1 existed) keep answering exactly as before, without every one of
   * them individually opting in. `false` for a test that specifically wants
   * an unconnected default author (LINK-1's own tests, and the SURF-4/D-31
   * identity tests, which use their own distinct `authorId`s and would
   * otherwise pick up an extra, unrelated person in `people.listPeople`'s
   * count).
   */
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

  // TEN-4 (data-layer half): `claimDiscordServerBinding` requires the
  // installer to actually belong to the organization, so an owner account is
  // created first.
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
      filePrefix: 'tc',
      enabled: options.enabled ?? true,
      adminsRole: options.adminsRole ?? 'admins-tc',
      studentsRole: options.studentsRole ?? 'students-tc',
      maxRequestsPerDay:
        options.maxRequestsPerDay === undefined
          ? 10
          : options.maxRequestsPerDay,
      promptId: options.promptId ?? null,
      // `?? 'Be helpful.'` can't tell "omitted" from "explicitly `null`" —
      // a test that needs a course with neither `promptId` nor
      // `instructions` set (SURF-6's not-configured case) checks `options.instructions`
      // against `undefined`, the same device `packages/core`'s own seed
      // helper uses.
      instructions:
        options.instructions === undefined
          ? 'Be helpful.'
          : options.instructions,
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

  // LINK-1 — see `SeedOptions.connectDefaultAuthor`'s own comment. Connected
  // the same way a real proof would (`@bloombot/auth`'s `person-link.ts`):
  // resolving a Discord identity, then merging a second (throwaway) identity
  // onto it, which is what actually sets `connectedAt`.
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
