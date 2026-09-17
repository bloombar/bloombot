/**
 * Repository for COST-8's approval gate: `course_approval_events` (the audit
 * trail) and the three `courses` columns it accompanies
 * (`ai_approved_at`/`ai_approved_by_account_id`/`ai_approval_decided_at`,
 * `schema.ts`'s own comment on why all three are nullable).
 *
 * `accountId` is `null` throughout this file for exactly one action,
 * `'auto-approve'` — the automatic rule (COST-8's own "a course belonging to
 * an administrator is approved automatically") has no human decision-maker
 * to record, unlike `'approve'`/`'revoke'`, which a platform administrator
 * always performs by hand (WEB-53). See `docs/DECISIONS.md` D-116.
 *
 * Every function here is scoped by `organizationId`, its first parameter,
 * except `listCoursesForApproval` — a platform-administrator read spanning
 * every organization by definition, the same documented TEN-2 exception
 * `cost-ledger.ts#listOrganizationTotals` already is.
 */

import { and, desc, eq, inArray } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import {
  accounts,
  courseApprovalEvents,
  courses,
  memberships,
  organizations,
  projects,
  type CourseApprovalAction,
} from '../schema.js'

export type CourseApprovalEvent = typeof courseApprovalEvents.$inferSelect

/**
 * `courseId`'s own audit trail (WEB-53's "recorded with who acted and
 * when"), newest first — the same shape `transcript-access.ts#listAccessLogForCourse`
 * already reads back ADMIN-2's audit trail in. Scoped by `organizationId`
 * like every function in this file except `listCoursesForApproval`.
 */
export function listApprovalEventsForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): CourseApprovalEvent[] {
  return db
    .select()
    .from(courseApprovalEvents)
    .where(
      and(
        eq(courseApprovalEvents.organizationId, organizationId),
        eq(courseApprovalEvents.courseId, courseId)
      )
    )
    .orderBy(desc(courseApprovalEvents.createdAt))
    .all()
}

/**
 * Record one approval event and return the row — used by `approveCourse`/
 * `revokeCourseApproval` below, never exported on its own: every caller of
 * this file records an event as part of an approval decision, never in
 * isolation.
 */
function recordApprovalEvent(
  organizationId: string,
  courseId: string,
  action: CourseApprovalAction,
  accountId: string | null,
  now: number,
  db: Executor
): CourseApprovalEvent {
  return db
    .insert(courseApprovalEvents)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      courseId,
      action,
      accountId,
      createdAt: now,
    })
    .returning()
    .get()
}

/**
 * Approve a course (COST-8) — `action` is `'auto-approve'` (creation-time or
 * `answerQuestion`'s own lazy approval, `accountId` always `null`) or
 * `'approve'` (a platform administrator's deliberate decision, WEB-53,
 * `accountId` always set). Idempotent: a course that is already approved is
 * left untouched and no event is written — approving an already-approved
 * course is not itself a new decision worth auditing.
 *
 * `undefined` when `courseId` does not exist, or does not belong to
 * `organizationId` (TEN-2/TEN-5).
 *
 * `db` accepts `Executor`, not just `Database` — `@bloombot/actions`'
 * `courses.import` calls this from inside its own transaction, atomically
 * with `createCourse` itself, the same "called from inside another
 * transaction" widening `course-instruction-revisions.ts#createRevision`'s
 * own doc comment already explains for the identical reason.
 */
export function approveCourse(
  organizationId: string,
  courseId: string,
  accountId: string | null,
  action: 'auto-approve' | 'approve',
  now: number,
  db: Executor
): Course | undefined {
  const course = db
    .select()
    .from(courses)
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .get()
  if (!course) return undefined

  // Already approved — a no-op, not an error (this function's own doc
  // comment).
  if (course.aiApprovedAt !== null) return course

  const updated = db
    .update(courses)
    .set({
      aiApprovedAt: now,
      aiApprovedByAccountId: accountId,
      aiApprovalDecidedAt: now,
    })
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .returning()
    .get()
  // Unreachable in practice — the same TEN-2 race every other repo function
  // in this package guards against rather than trusts away: the row was
  // just read, above, inside this same call.
  if (!updated) return undefined

  recordApprovalEvent(organizationId, courseId, action, accountId, now, db)
  return updated
}

/**
 * Revoke a course's approval (COST-8) — always a platform administrator's
 * own deliberate decision, so `accountId` is required here, unlike
 * `approveCourse`'s optional one. Clears `aiApprovedAt`/
 * `aiApprovedByAccountId` back to `null` (the course is pending again) but
 * — critically — *sets* `aiApprovalDecidedAt`, which is what stops
 * `answerQuestion`'s own lazy auto-approval from re-approving a course a
 * platform administrator just took away AI access from (`schema.ts`'s own
 * comment on that column).
 *
 * `undefined` when `courseId` does not exist, or does not belong to
 * `organizationId` (TEN-2/TEN-5).
 */
export function revokeCourseApproval(
  organizationId: string,
  courseId: string,
  accountId: string,
  now: number,
  db: Executor
): Course | undefined {
  const updated = db
    .update(courses)
    .set({
      aiApprovedAt: null,
      aiApprovedByAccountId: null,
      aiApprovalDecidedAt: now,
    })
    .where(
      and(eq(courses.id, courseId), eq(courses.organizationId, organizationId))
    )
    .returning()
    .get()
  if (!updated) return undefined

  recordApprovalEvent(organizationId, courseId, 'revoke', accountId, now, db)
  return updated
}

type Course = typeof courses.$inferSelect

/**
 * `true` when `organizationId` is "an administrator's" own organization
 * (COST-8's second half of the definition: "one in an organization an
 * administrator owns") — an `owner` membership (TEN-1) held by a
 * non-disabled account whose email `isAdminEmail` accepts. `isAdminEmail` is
 * supplied by the caller rather than imported: this package holds no
 * dependency on `@bloombot/auth` (an env-reading package) at all, the same
 * "dependencies as arguments" discipline `packages/core`'s own `answer.ts`
 * holds itself to (D-29) — see `docs/DECISIONS.md` D-116 for the full
 * reasoning and where each caller gets its own real predicate from.
 *
 * Shared by `@bloombot/actions`' `courses.save`/`courses.import` (creation
 * time) and `@bloombot/core`'s `answerQuestion` (lazy auto-approval): both
 * need the identical "does this organization have an administrator owner"
 * read, and a second copy of it in each package is exactly the kind of
 * duplicated logic that drifts the moment one copy is fixed and the other
 * is not.
 */
export function isAdministratorOwnedOrganization(
  organizationId: string,
  isAdminEmail: (email: string | null | undefined) => boolean,
  db: Executor
): boolean {
  const owners = db
    .select({
      accountId: memberships.accountId,
      email: accounts.email,
      disabledAt: accounts.disabledAt,
    })
    .from(memberships)
    .innerJoin(accounts, eq(accounts.id, memberships.accountId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, 'owner')
      )
    )
    .all()

  return owners.some(
    (owner) => owner.disabledAt === null && isAdminEmail(owner.email)
  )
}

/** One row `listCoursesForApproval` below returns — everything WEB-53's admin console (next slice) needs to render one course, pending or approved. */
export interface CourseForApproval {
  courseId: string
  courseTitle: string
  projectName: string
  organizationName: string
  organizationId: string
  /** Every active owner's email, ADMIN-4's own "who to ask" for a course a platform administrator is deciding on. */
  ownerEmails: string[]
  createdAt: number
  aiApprovedAt: number | null
  /**
   * `null` for a pending course, and also for one approved by
   * `'auto-approve'` (this file's own module comment — no human
   * decision-maker to name). WEB-53's console shows the email rather than
   * this id; kept here too since a caller that already has the id has no
   * other way to distinguish "approved automatically" from "the account
   * that approved it was later deleted".
   */
  aiApprovedByAccountId: string | null
  /** The approving account's email — WEB-53's "who acted" — `null` under the same conditions as `aiApprovedByAccountId`. */
  aiApprovedByEmail: string | null
}

/**
 * Every course across every organization (this file's own module comment
 * has the TEN-2 exception this is), with enough for WEB-53's admin console
 * to list both pending and approved courses without a second round trip per
 * row. Newest-created first — an administrator's own queue is naturally
 * "what showed up recently that needs a decision," not an alphabetical
 * list.
 */
export function listCoursesForApproval(db: Database): CourseForApproval[] {
  const rows = db
    .select({
      courseId: courses.id,
      courseTitle: courses.title,
      organizationId: courses.organizationId,
      organizationName: organizations.name,
      projectName: projects.name,
      createdAt: courses.createdAt,
      aiApprovedAt: courses.aiApprovedAt,
      aiApprovedByAccountId: courses.aiApprovedByAccountId,
    })
    .from(courses)
    .innerJoin(projects, eq(projects.id, courses.projectId))
    .innerJoin(organizations, eq(organizations.id, courses.organizationId))
    .orderBy(desc(courses.createdAt))
    .all()

  // Approver emails, batched by id — the same "one extra query rather than
  // one per row" shape the owner-email lookup below already takes, over
  // only the (usually small) set of accounts this page's courses were
  // actually approved by.
  const approverAccountIds = [
    ...new Set(
      rows
        .map((row) => row.aiApprovedByAccountId)
        .filter((id): id is string => id !== null)
    ),
  ]
  const approverEmailsByAccountId = new Map<string, string>()
  if (approverAccountIds.length > 0) {
    const approverRows = db
      .select({ id: accounts.id, email: accounts.email })
      .from(accounts)
      .where(inArray(accounts.id, approverAccountIds))
      .all()
    for (const approver of approverRows) {
      approverEmailsByAccountId.set(approver.id, approver.email)
    }
  }

  // One query for every organization's active owners, rather than one per
  // course row — the same "batch the fan-out" shape `costLedger`'s own
  // cross-organization read already takes for its per-organization totals.
  const ownerRows = db
    .select({
      organizationId: memberships.organizationId,
      email: accounts.email,
      disabledAt: accounts.disabledAt,
    })
    .from(memberships)
    .innerJoin(accounts, eq(accounts.id, memberships.accountId))
    .where(eq(memberships.role, 'owner'))
    .all()

  const ownerEmailsByOrganizationId = new Map<string, string[]>()
  for (const owner of ownerRows) {
    if (owner.disabledAt !== null) continue
    const existing = ownerEmailsByOrganizationId.get(owner.organizationId)
    if (existing) {
      existing.push(owner.email)
    } else {
      ownerEmailsByOrganizationId.set(owner.organizationId, [owner.email])
    }
  }

  return rows.map((row) => ({
    courseId: row.courseId,
    courseTitle: row.courseTitle,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    projectName: row.projectName,
    ownerEmails: ownerEmailsByOrganizationId.get(row.organizationId) ?? [],
    createdAt: row.createdAt,
    aiApprovedAt: row.aiApprovedAt,
    aiApprovedByAccountId: row.aiApprovedByAccountId,
    aiApprovedByEmail:
      row.aiApprovedByAccountId === null
        ? null
        : (approverEmailsByAccountId.get(row.aiApprovedByAccountId) ?? null),
  }))
}
