/**
 * Test helper: the smallest organization graph `discord-scaffold.test.ts`
 * needs — an organization, a bound Discord server, and a course with
 * categories/channels — synthetic data only (QA-3), written through
 * `@bloombot/db`'s own repos, never raw SQL.
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

export interface SeededCourse {
  organizationId: string
  guildId: string
  courseId: string
  adminsRole: string
  studentsRole: string
}

/**
 * One organization, with a Discord server actively bound to it and one
 * course declaring `categories` — the exact shape
 * `@bloombot/db`'s own `courses.createCourse` takes for `NewCourse.categories`.
 */
export function seedOrganizationWithBoundCourse(
  db: Database,
  categories: courses.NewCourseCategory[],
  options?: { adminsRole?: string; studentsRole?: string }
): SeededCourse {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    db
  )

  const installer = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Admin',
      role: 'owner',
    },
    db
  )
  const guildId = randomUUID().replace(/-/g, '').slice(0, 18)
  discordServers.claimDiscordServerBinding(
    organizationId,
    { serverId: guildId, installedByAccountId: installer.id },
    db
  )

  const project = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    db
  )

  const adminsRole = options?.adminsRole ?? 'course-admins'
  const studentsRole = options?.studentsRole ?? 'course-students'
  const result = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole,
      studentsRole,
      categories,
    },
    db
  )
  if (!result.ok) {
    throw new Error(
      `seedOrganizationWithBoundCourse: ${result.conflict.message}`
    )
  }

  return {
    organizationId,
    guildId,
    courseId: result.course.id,
    adminsRole,
    studentsRole,
  }
}
