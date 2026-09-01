/**
 * Test helper: the smallest organization graph these tests need, synthetic
 * data only (QA-3) — written through `@bloombot/db`'s own repos, never raw
 * SQL, never through `dispatch` (the tests exercising `dispatch` need a
 * scenario already in place, not one built by the thing they are testing).
 */

import { randomUUID } from 'node:crypto'

import { organizations, projects, type Database } from '@bloombot/db'

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
