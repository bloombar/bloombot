/**
 * Test helper: the smallest organization graph these tests need, synthetic
 * data only (QA-3) — written through `@bloombot/db`'s own repos, never raw
 * SQL, never through `dispatch` (the tests exercising `dispatch` need a
 * scenario already in place, not one built by the thing they are testing).
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

/** One organization, ready for an action's policy to resolve against. */
export function seedOrganization(db: Database, name = 'Test Org'): string {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name, isPersonal: false },
    db
  )
  return organizationId
}

/** One organization with a Discord server actively bound to it — `discordServers.remove`'s own scenario. */
export function seedOrganizationWithBoundServer(
  db: Database,
  name = 'Test Org'
): { organizationId: string; serverId: string; installerAccountId: string } {
  const organizationId = seedOrganization(db, name)
  const installer = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Admin',
      role: 'owner',
    },
    db
  )
  const serverId = randomUUID()
  discordServers.claimDiscordServerBinding(
    organizationId,
    { serverId, installedByAccountId: installer.id },
    db
  )
  return { organizationId, serverId, installerAccountId: installer.id }
}

/** One organization with one active project in it. */
export function seedOrganizationWithProject(
  db: Database,
  projectName = 'Test Term'
): { organizationId: string; projectId: string } {
  const organizationId = seedOrganization(db)
  const project = projects.createProject(
    organizationId,
    { name: projectName },
    db
  )
  return { organizationId, projectId: project.id }
}

/** One organization with one owner account and one enabled course — ENRL-1..6's own scenario: a join link, a grant, or an enrolment all need somewhere to attach. */
export function seedOrganizationWithCourse(
  db: Database,
  overrides: Partial<{ adminsRole: string; studentsRole: string }> = {}
): {
  organizationId: string
  ownerId: string
  course: courses.CourseWithCategories
} {
  const { organizationId, projectId } = seedOrganizationWithProject(db)
  const owner = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Owner',
      role: 'owner',
    },
    db
  )
  const result = courses.createCourse(
    organizationId,
    {
      projectId,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: overrides.adminsRole ?? `admins-${randomUUID()}`,
      studentsRole: overrides.studentsRole ?? `students-${randomUUID()}`,
      categories: [],
    },
    db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return { organizationId, ownerId: owner.id, course: result.course }
}
