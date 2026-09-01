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
  projects,
  type Database,
} from '@bloombot/db'

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

  return { organizationId, courseId: courseResult.course.id, guildId }
}
