/**
 * Repository for `roster_import_acknowledgements` (ROST-20): the durable
 * record that ROST-19's acknowledgement was shown and agreed to, one row per
 * roster import.
 *
 * `recordAcknowledgement` accepts `Executor`, not just `Database` — it is
 * meant to be called from inside `@bloombot/actions`' `roster.import`, in
 * the same `writeTransaction(...)` as `jobs.enqueueJob` itself
 * (`repos/jobs.ts`'s own doc comment on why that function was widened for
 * this), so an import that never started records nothing, and an import
 * that started can never lack one — exactly ROST-20's own text.
 *
 * There is no update or delete function in this file, on purpose — the same
 * "an account of something that happened, not a setting" discipline
 * `repos/course-approval.ts` already holds `course_approval_events` to.
 *
 * Every function here is scoped by `organizationId`, its first parameter,
 * except `listAcknowledgementsForAccount` — ADMIN-11's own cross-tenant
 * read, the same documented TEN-2 exception `enrolments.ts#listEnrolmentsForPeople`
 * already is, allowlisted in `tests/tenant-scoping-convention.test.ts`
 * accordingly.
 */

import { and, desc, eq } from 'drizzle-orm'

import type { Database, Executor } from '../client.js'
import {
  courses,
  organizations,
  rosterImportAcknowledgements,
} from '../schema.js'

export type RosterImportAcknowledgement =
  typeof rosterImportAcknowledgements.$inferSelect

/** Fields the caller supplies when recording an acknowledgement. */
export interface NewRosterImportAcknowledgement {
  courseId: string
  /** The account that ticked ROST-19's box. */
  accountId: string
  filename: string
  /** The `roster.import` job this acknowledgement accompanied (`repos/jobs.ts`). */
  jobId: string
  /** ROST-20's own point — the wording's own version identifier, as it stood the moment this was recorded. */
  acknowledgementVersion: string
  acknowledgedAt: number
}

/**
 * Record one acknowledgement. Called once per roster import, alongside
 * `jobs.enqueueJob` — this file's own module comment has the "same
 * transaction" reasoning.
 */
export function recordAcknowledgement(
  organizationId: string,
  input: NewRosterImportAcknowledgement,
  db: Executor
): RosterImportAcknowledgement {
  return db
    .insert(rosterImportAcknowledgements)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      courseId: input.courseId,
      accountId: input.accountId,
      filename: input.filename,
      jobId: input.jobId,
      acknowledgementVersion: input.acknowledgementVersion,
      acknowledgedAt: input.acknowledgedAt,
    })
    .returning()
    .get()
}

/**
 * A course's own acknowledgements, newest first — the course's Roster tab
 * (the instructor who can already import there) and ADMIN-9's course
 * screen both read this.
 */
export function listAcknowledgementsForCourse(
  organizationId: string,
  courseId: string,
  db: Database
): RosterImportAcknowledgement[] {
  return db
    .select()
    .from(rosterImportAcknowledgements)
    .where(
      and(
        eq(rosterImportAcknowledgements.organizationId, organizationId),
        eq(rosterImportAcknowledgements.courseId, courseId)
      )
    )
    .orderBy(desc(rosterImportAcknowledgements.acknowledgedAt))
    .all()
}

/** One acknowledgement `listAcknowledgementsForAccount` below returns, its course and organization named alongside it — ADMIN-11's own "every course and organization named on this screen is a link" (`AppLink`/`buildPath`). */
export interface AccountRosterAcknowledgement {
  id: string
  courseId: string
  courseTitle: string
  organizationId: string
  organizationName: string
  filename: string
  acknowledgementVersion: string
  acknowledgedAt: number
}

/**
 * ADMIN-11 — every acknowledgement `accountId` has ever made, across every
 * course and organization, newest first. TEN-2 exception (this file's own
 * module comment): an account's own acknowledgements are not scoped to one
 * organization until this call names them, the same reason
 * `enrolments.ts#listEnrolmentsForPeople` is unscoped for the identical
 * "account, not organization" question.
 */
export function listAcknowledgementsForAccount(
  accountId: string,
  db: Database
): AccountRosterAcknowledgement[] {
  return db
    .select({
      id: rosterImportAcknowledgements.id,
      courseId: rosterImportAcknowledgements.courseId,
      courseTitle: courses.title,
      organizationId: rosterImportAcknowledgements.organizationId,
      organizationName: organizations.name,
      filename: rosterImportAcknowledgements.filename,
      acknowledgementVersion:
        rosterImportAcknowledgements.acknowledgementVersion,
      acknowledgedAt: rosterImportAcknowledgements.acknowledgedAt,
    })
    .from(rosterImportAcknowledgements)
    .innerJoin(courses, eq(courses.id, rosterImportAcknowledgements.courseId))
    .innerJoin(
      organizations,
      eq(organizations.id, rosterImportAcknowledgements.organizationId)
    )
    .where(eq(rosterImportAcknowledgements.accountId, accountId))
    .orderBy(desc(rosterImportAcknowledgements.acknowledgedAt))
    .all()
}
