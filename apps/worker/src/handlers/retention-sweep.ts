/**
 * `retention.sweep` (DATA-8, `docs/SPEC.md` §49) — the scheduled job that
 * permanently removes what DATA-7's soft delete has already released:
 * every record across the six deletable entities (accounts, people,
 * organizations, projects, courses, conversations) whose `deletedAt` is
 * older than `DELETED_DATA_RETENTION_DAYS`.
 *
 * **Reuses the existing cascades, never a third hand-written order**
 * (DATA-8's own text): an organization is removed through
 * `@bloombot/db`'s `organizations.deleteOrganizationData`, a project
 * through `deletions.deleteProject`, a course through
 * `deletions.deleteCourse` — the identical functions ADMIN-5's tenant
 * delete and PROJ-8/PROJ-9's course/project delete already use. A person or
 * a conversation has no existing permanent-delete cascade to reuse (only a
 * soft-delete/restore pair) — `people.ts#permanentlyDeletePerson` and
 * `conversations.ts#permanentlyDeleteConversation` are new, but genuinely
 * new (see each function's own doc comment for the FK-safe order),
 * everywhere they can be. An account's own cascade
 * (`accounts.ts#permanentlyDeleteAccount`) is deliberately partial — see
 * that function's own doc comment, and docs/DECISIONS.md, for the accounts
 * this sweep cannot yet finish removing and why that is a retried partial
 * failure rather than a crash.
 *
 * **Bytes go through the existing content-deletion job**
 * (`REMOVE_DELETED_CONTENT_BYTES_JOB_KIND`,
 * `handlers/content-deletions.ts`), never a second implementation: an
 * organization's or a project's or a course's own removal gathers each
 * course's `deletions.CourseByteRemoval` *inside* the same transaction the
 * row removal runs in (`deleteOrganizationData`/`deleteProject`/
 * `deleteCourse` all already do this — see their own doc comments), and
 * this handler enqueues that job with them immediately after, the same
 * "rows in a transaction, bytes in a job" split
 * `@bloombot/actions`'s `enqueueRemoveDeletedContentBytes` already holds
 * itself to for an ordinary delete action.
 * `REMOVE_DELETED_CONTENT_BYTES_JOB_KIND`/`enqueueContentBytesRemoval`
 * below are a deliberate duplicate of that file's own constant and
 * enqueue logic — this app does not depend on `@bloombot/actions` (no
 * other handler here does either), the same "kind string duplicated on
 * both sides, no shared constant module" convention
 * `actions/courses.ts`'s own module comment already follows for this exact
 * job kind.
 *
 * **Partial failure, per record**: a record this sweep cannot remove (a
 * provider call the content-deletion job's own retry will handle
 * separately; here, an account or a person still referenced by a table
 * this sweep does not touch) is logged and skipped — the surrounding
 * `writeTransaction` each `deleteX` call already opens rolls back on its
 * own, so nothing about that one record is left half-done, and its
 * `deletedAt` is untouched for the next run to retry.
 *
 * **Schedules its own successor**: `NewJob.availableAt` (the queue's own
 * "run later" primitive, `@bloombot/db`'s `repos/jobs.ts`) sets the next
 * run's `nextAttemptAt` — `RETENTION_SWEEP_INTERVAL_MS` below is this
 * slice's own judgment call, not something DATA-8's text names a config
 * knob for (see docs/DECISIONS.md). Guarded against accumulating
 * duplicates by `jobs.hasQueuedJobOfKind`, excluding this job's own,
 * still-`running` id. `apps/worker/src/index.ts` also enqueues one at
 * startup, the same guard, so a deployment that has been down does not
 * silently stop deleting.
 *
 * **`DELETED_DATA_RETENTION_DAYS=0` disables the sweep** (DATA-8's own
 * text: "a deliberate choice a deployment can make and not a default") —
 * the handler still runs, on schedule, so it is still visible on the Jobs
 * screen, but removes nothing and reports zero for every count.
 */

import {
  accounts,
  conversations,
  courses,
  deletions,
  jobs,
  organizations,
  people,
  projects,
  type Database,
} from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

import { REMOVE_DELETED_CONTENT_BYTES_JOB_KIND } from './content-deletions.js'

export const RETENTION_SWEEP_JOB_KIND = 'retention.sweep'
const RETENTION_SWEEP_MAX_ATTEMPTS = 5

/**
 * How often the sweep re-schedules itself. DATA-8's own text names only the
 * retention *window* (`DELETED_DATA_RETENTION_DAYS`) as configuration; the
 * sweep's own cadence is not — a day is frequent enough that nothing sits
 * past its window for long, and coarse enough that the sweep is not
 * meaningfully more of the queue's own traffic than any other periodic job
 * this platform runs. See docs/DECISIONS.md.
 */
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

const MS_PER_DAY = 24 * 60 * 60 * 1000

const REMOVE_DELETED_CONTENT_BYTES_JOB_MAX_ATTEMPTS = 5

export interface RetentionSweepDependencies {
  /** `DELETED_DATA_RETENTION_DAYS`, read once at worker startup (this file's own module comment on why `0` disables the sweep rather than being refused). */
  retentionDays: number
  logger: Logger
}

/** What one sweep run actually did — the report `@bloombot/jobs`' own `completeJob` records as this job's `result`, the same "opaque report, not enforced by the queue" every other handler here already returns. */
export interface RetentionSweepReport {
  organizationsRemoved: number
  projectsRemoved: number
  coursesRemoved: number
  peopleRemoved: number
  conversationsRemoved: number
  accountsRemoved: number
  /** How many candidate records this run found but could not remove — logged individually, left marked for the next run to retry. */
  failures: number
}

/**
 * A deliberate duplicate of `@bloombot/actions`'s
 * `enqueueRemoveDeletedContentBytes` (`actions/courses.ts`) — this file's
 * own module comment has why. Enqueues `REMOVE_DELETED_CONTENT_BYTES_JOB_KIND`
 * naming every course's own `CourseByteRemoval`, or nothing at all when none
 * of them has an attachment or an export to remove.
 */
function enqueueContentBytesRemoval(
  organizationId: string,
  courseRemovals: deletions.CourseByteRemoval[],
  db: Database
): void {
  const hasWork = courseRemovals.some(
    (removal) => removal.attachments.length > 0 || removal.exportIds.length > 0
  )
  if (!hasWork) return
  jobs.enqueueJob(
    organizationId,
    {
      kind: REMOVE_DELETED_CONTENT_BYTES_JOB_KIND,
      payload: { courses: courseRemovals },
      maxAttempts: REMOVE_DELETED_CONTENT_BYTES_JOB_MAX_ATTEMPTS,
    },
    db
  )
}

/**
 * DATA-8 — schedules `RETENTION_SWEEP_JOB_KIND`'s own next run,
 * `RETENTION_SWEEP_INTERVAL_MS` from now, unless one is already queued.
 * `excludeJobId` is this job's own id when called from inside the handler
 * (still `running`, not yet terminal — `jobs.hasQueuedJobOfKind`'s own doc
 * comment has why that exclusion matters) and `''` — never a real job id —
 * when called from `apps/worker/src/index.ts` at startup, where there is no
 * "self" to exclude.
 *
 * Silently does nothing when no organization exists at all
 * (`organizations.pickReferenceOrganizationId` returns `undefined`) — a
 * fresh install with nobody signed up yet has nothing to sweep, and no
 * valid `jobs.organizationId` to attach a row to either; logged, not
 * thrown, since this is an expected, recoverable state, not a defect.
 */
export function ensureRetentionSweepScheduled(
  excludeJobId: string,
  db: Database,
  logger: Logger
): void {
  if (jobs.hasQueuedJobOfKind(RETENTION_SWEEP_JOB_KIND, excludeJobId, db)) {
    return
  }
  const referenceOrganizationId = organizations.pickReferenceOrganizationId(db)
  if (!referenceOrganizationId) {
    logger.info(
      {},
      'apps/worker: retention sweep not scheduled — no organization exists yet'
    )
    return
  }
  jobs.enqueueJob(
    referenceOrganizationId,
    {
      kind: RETENTION_SWEEP_JOB_KIND,
      payload: {},
      maxAttempts: RETENTION_SWEEP_MAX_ATTEMPTS,
      availableAt: Date.now() + RETENTION_SWEEP_INTERVAL_MS,
    },
    db
  )
}

/**
 * DATA-8's own row-removal pass — every deletable entity whose `deletedAt`
 * is at or before `now - retentionDays` days. Separated from
 * `createRetentionSweepHandler` below (which supplies the real clock and
 * then schedules the successor) so a test can drive `now` explicitly rather
 * than waiting on a real one — `slide-machine`'s own
 * `purgeExpiredSoftDeletes(olderThanDays, now)` is the shape this copies.
 */
export function runRetentionSweep(
  retentionDays: number,
  now: number,
  db: Database,
  logger: Logger
): RetentionSweepReport {
  const report: RetentionSweepReport = {
    organizationsRemoved: 0,
    projectsRemoved: 0,
    coursesRemoved: 0,
    peopleRemoved: 0,
    conversationsRemoved: 0,
    accountsRemoved: 0,
    failures: 0,
  }

  // DATA-8 — a zero window disables the sweep, deliberately: nothing below
  // runs, but the caller (the job handler, below) still completes and
  // still reschedules its own successor, so it stays visible on the Jobs
  // screen rather than vanishing the moment a deployment turns it off.
  if (retentionDays > 0) {
    const cutoff = now - retentionDays * MS_PER_DAY

    // Top-down: an organization's or a project's own removal already
    // wipes every course, person and conversation it owned regardless of
    // that row's own `deletedAt` (`deleteOrganizationData`/`deleteProject`'s
    // own doc comments) — processing organizations, then projects, then
    // courses, then people, then conversations means nothing already
    // removed by a step above is found again by one below.
    for (const organization of organizations.listOrganizationsDeletedBefore(
      cutoff,
      db
    )) {
      try {
        const result = organizations.deleteOrganizationData(organization.id, db)
        if (result) {
          report.organizationsRemoved += 1
          enqueueContentBytesRemoval(organization.id, result.byteRemovals, db)
        }
      } catch (error) {
        report.failures += 1
        logger.warn(
          { err: error, organizationId: organization.id },
          'apps/worker: retention sweep could not remove an organization past its retention window — left marked for the next run'
        )
      }
    }

    for (const project of projects.listProjectsDeletedBefore(cutoff, db)) {
      if (project.deletedByAccountId === null) {
        // Defensive, not expected to hit — `softDeleteProject` always sets
        // `deletedAt`/`deletedByAccountId` together (DATA-7). Treated as a
        // failure, not a crash, the same discipline every other guard in
        // this handler holds itself to.
        report.failures += 1
        logger.warn(
          { projectId: project.id },
          'apps/worker: retention sweep found a deleted project with no deletedByAccountId — left marked for the next run'
        )
        continue
      }
      try {
        const result = deletions.deleteProject(
          project.organizationId,
          project.id,
          { deletedByAccountId: project.deletedByAccountId },
          db
        )
        if (result) {
          report.projectsRemoved += 1
          enqueueContentBytesRemoval(
            project.organizationId,
            result.byteRemovals,
            db
          )
        }
      } catch (error) {
        report.failures += 1
        logger.warn(
          { err: error, projectId: project.id },
          'apps/worker: retention sweep could not remove a project past its retention window — left marked for the next run'
        )
      }
    }

    for (const course of courses.listCoursesDeletedBefore(cutoff, db)) {
      if (course.deletedByAccountId === null) {
        report.failures += 1
        logger.warn(
          { courseId: course.id },
          'apps/worker: retention sweep found a deleted course with no deletedByAccountId — left marked for the next run'
        )
        continue
      }
      try {
        const result = deletions.deleteCourse(
          course.organizationId,
          course.id,
          { deletedByAccountId: course.deletedByAccountId },
          db
        )
        if (result) {
          report.coursesRemoved += 1
          enqueueContentBytesRemoval(
            course.organizationId,
            [result.byteRemoval],
            db
          )
        }
      } catch (error) {
        report.failures += 1
        logger.warn(
          { err: error, courseId: course.id },
          'apps/worker: retention sweep could not remove a course past its retention window — left marked for the next run'
        )
      }
    }

    for (const person of people.listPeopleDeletedBefore(cutoff, db)) {
      try {
        const removed = people.permanentlyDeletePerson(
          person.organizationId,
          person.id,
          db
        )
        if (removed) report.peopleRemoved += 1
      } catch (error) {
        report.failures += 1
        logger.warn(
          { err: error, personId: person.id },
          'apps/worker: retention sweep could not remove a person past its retention window — left marked for the next run'
        )
      }
    }

    for (const conversation of conversations.listConversationsDeletedBefore(
      cutoff,
      db
    )) {
      try {
        const removed = conversations.permanentlyDeleteConversation(
          conversation.organizationId,
          conversation.id,
          db
        )
        if (removed) report.conversationsRemoved += 1
      } catch (error) {
        report.failures += 1
        logger.warn(
          { err: error, conversationId: conversation.id },
          'apps/worker: retention sweep could not remove a conversation past its retention window — left marked for the next run'
        )
      }
    }

    // Accounts last — not because anything else depends on it (an
    // account has no child in this package's own deletable set,
    // `accounts.ts#softDeleteAccount`'s own doc comment), simply the
    // widest-referenced table (`accounts.ts#permanentlyDeleteAccount`'s
    // own doc comment), so the same-run log reads organization-scoped
    // content first.
    for (const account of accounts.listAccountsDeletedBefore(cutoff, db)) {
      try {
        const removed = accounts.permanentlyDeleteAccount(account.id, db)
        if (removed) report.accountsRemoved += 1
      } catch (error) {
        report.failures += 1
        logger.warn(
          { err: error, accountId: account.id },
          'apps/worker: retention sweep could not remove an account past its retention window — left marked for the next run'
        )
      }
    }
  }

  return report
}

/**
 * The `JobHandler` `@bloombot/jobs`' own `runNextJob` actually calls: the
 * real clock, `context.db`, `deps.logger` — `runRetentionSweep` above does
 * the work, this schedules the successor afterward
 * (`ensureRetentionSweepScheduled`'s own doc comment).
 */
export function createRetentionSweepHandler(
  deps: RetentionSweepDependencies
): JobHandler {
  return async (
    _payload: unknown,
    context: JobContext
  ): Promise<RetentionSweepReport> => {
    const report = runRetentionSweep(
      deps.retentionDays,
      Date.now(),
      context.db,
      deps.logger
    )
    ensureRetentionSweepScheduled(context.jobId, context.db, deps.logger)
    return report
  }
}
