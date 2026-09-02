/**
 * Test helper: the smallest signed-in-account graph these tests need —
 * organization, account, membership and a live session — written through
 * `@bloombot/db`'s and `@bloombot/auth`'s own functions, never raw SQL and
 * never through the MCP surface these tests exercise (the tests proving
 * that surface need a scenario already in place, not one built by the
 * thing they are testing). The same convention `apps/api/tests/helpers/seed.ts`
 * already uses for its own cookie-carried session.
 */

import { randomUUID } from 'node:crypto'

import { createSession } from '@bloombot/auth'
import {
  accounts,
  courseAttachments,
  courses,
  memberships,
  organizations,
  projects,
  type Database,
} from '@bloombot/db'

export interface SignedInAccount {
  organizationId: string
  accountId: string
  /** The session's plaintext token — presented as `Authorization: Bearer <token>` to this surface (MCP-3), the same token a cookie carries for `apps/api`. */
  token: string
}

/** One organization, one account, a membership binding them, and a live session for that account. */
export function seedSignedInAccount(
  db: Database,
  options: { organizationName?: string; role?: memberships.MembershipRole } = {}
): SignedInAccount {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: options.organizationName ?? 'Test Org', isPersonal: false },
    db
  )
  const account = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Test Account',
      role: options.role ?? 'owner',
    },
    db
  )
  const session = createSession(account.id, db)

  return { organizationId, accountId: account.id, token: session.token }
}

/**
 * `organizationId`'s own course, ready for anything that needs a real
 * `courseId` to resolve — a project, then a course inside it, the same
 * minimal graph `packages/actions/tests/helpers/seed.ts#seedOrganizationWithCourse`
 * builds, duplicated here rather than imported across an app boundary test
 * helpers are not published through. `categories`, when given, seeds
 * `courses.save`'s own destructive replace (MCP-4) with something real to
 * replace.
 */
export function seedCourse(
  db: Database,
  organizationId: string,
  options: {
    title?: string
    categories?: courses.NewCourse['categories']
  } = {}
): { courseId: string; projectId: string } {
  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )
  const result = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: options.title ?? 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: `admins-${randomUUID()}`,
      studentsRole: `students-${randomUUID()}`,
      categories: options.categories ?? [],
    },
    db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return { courseId: result.course.id, projectId: project.id }
}

/** `organizationId`'s own attachment, ready for `courseAttachments.detach` (MCP-4's one destructive tool) to resolve and delete — a course (`seedCourse`, above) with one `pending` attachment on it. */
export function seedAttachment(db: Database, organizationId: string): string {
  const { courseId } = seedCourse(db, organizationId)
  const attachment = courseAttachments.createPendingAttachment(
    organizationId,
    {
      courseId,
      filename: 'notes.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    },
    db
  )
  return attachment.id
}

/** A second organization with no membership for any caller seeded above — MCP-3's own "carries that account's memberships and nothing more", proven directly by trying to reach this organization's id. */
export function seedOtherOrganization(db: Database): string {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Other Org', isPersonal: false },
    db
  )
  return organizationId
}
