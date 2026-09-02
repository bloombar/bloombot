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
  jobs,
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

/**
 * A **completed** `roster.import` job, carrying a realistic
 * `RosterImportReport` (`apps/worker/src/handlers/roster-import.ts`) as its
 * own `result` — student emails and Discord handles in several of the
 * report's own fields, the same shape a real successful import leaves
 * behind. Claims the job before completing it (`jobs.completeJob` only
 * writes a `running` job it owns) rather than writing the row directly, the
 * same "written through the real repos" convention this file's own module
 * comment already holds itself to. Returns the job id, ready for
 * `jobs.get` to resolve.
 */
export function seedCompletedRosterImportJob(
  db: Database,
  organizationId: string
): string {
  const enqueued = jobs.enqueueJob(
    organizationId,
    {
      kind: 'roster.import',
      payload: {
        courseId: 'course-1',
        csvText:
          'Last,First,Email,GitHub,Discord\nLovelace,Ada,ada@school.edu,,ada#1',
      },
      maxAttempts: 5,
    },
    db
  )
  const owner = `test-owner-${randomUUID()}`
  const claimed = jobs.claimNextJob(
    ['roster.import'],
    { owner, leaseMs: 60_000 },
    db
  )
  if (!claimed) throw new Error('setup failed: could not claim the seeded job')
  if (claimed.claimExpiresAt === null) {
    throw new Error('setup failed: claimed job has no lease')
  }

  const report = {
    courseId: 'course-1',
    guildId: 'guild-1',
    parseErrors: [],
    peopleCreated: [{ line: 2, discord: 'ada#1', personId: 'person-1' }],
    peopleMerged: [],
    rosterFieldsDeclined: [],
    unresolvedHandles: [{ line: 3, discord: 'bob#2', email: 'bob@school.edu' }],
    ambiguousHandles: [],
    channelsCreated: [
      {
        line: 2,
        email: 'ada@school.edu',
        channelName: 'ada',
        category: 'Week 1',
      },
    ],
    channelsAlreadyPresent: [],
    channelAccessGranted: [],
    channelAccessGrantFailed: [],
    channelsNotCreated: [],
    channelsFailed: [],
    channelNameCollisions: [],
    unresolvedRoles: [],
    limitations: [],
  }
  jobs.completeJob(
    organizationId,
    claimed.id,
    { owner, claimExpiresAt: claimed.claimExpiresAt },
    db,
    report
  )
  return enqueued.id
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
