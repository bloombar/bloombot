/**
 * `courseApproval.notifyPending` (ADMIN-14, `docs/SPEC.md` §45) — a course
 * became pending approval — created without qualifying for COST-8's own
 * automatic approval, imported, duplicated, or an administrator revoked an
 * existing approval (`@bloombot/actions`'s
 * `enqueueCourseApprovalNotifyPending`, `actions/courses.ts`'s own doc
 * comment has every call site) — and this handler tells the deployment's
 * own support address, naming the course, its project, its organization and
 * its owner, and carrying a link to that course's own console screen so an
 * administrator can decide from the message.
 *
 * Two "send nothing" cases, both a success, never a retry (the spec's own
 * "records why rather than failing the operation that triggered it"):
 *
 *  - **No support address configured** (`SUPPORT_CONTACT` unset — `deps.supportContact`
 *    is `''`, `@bloombot/config`'s own schema default). Logged and done —
 *    the same "an operator sees why, nothing is silently dropped forever"
 *    reasoning `@bloombot/mail#buildEmailSender`'s own module comment
 *    already applies to a missing mail transport, one level up.
 *  - **The course is no longer pending by the time this runs** — an
 *    administrator approved it while the job sat in the queue. Re-read here,
 *    not trusted from the payload: never send a stale "still pending"
 *    notification about a decision that has already been made.
 */

import type { EmailSender } from '@bloombot/auth'
import { courseApproval, courses, organizations, projects } from '@bloombot/db'
import type { JobContext, JobHandler } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

import { buildCourseApprovalConsoleLink } from '../course-approval-link.js'

/** ADMIN-14's own job kind — the same literal `@bloombot/actions`'s `enqueueCourseApprovalNotifyPending` (`actions/courses.ts`) enqueues under, duplicated on both sides by this platform's own convention (`REMOVE_DELETED_CONTENT_BYTES_JOB_KIND`'s doc comment, `actions/courses.ts`) — an app depends on `@bloombot/actions`, never the reverse, so nothing here can import the constant from there. */
export const COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND =
  'courseApproval.notifyPending'

export interface CourseApprovalNotificationHandlerDependencies {
  emailSender: EmailSender
  /** `CONFIG.SUPPORT_CONTACT` — `''` (its schema default) means "not configured". */
  supportContact: string
  /** TEN-4 — `CONFIG.PUBLIC_APP_URL`, never hard-coded; threaded to `buildCourseApprovalConsoleLink`. */
  publicAppUrl: string
  logger: Logger
}

interface NotifyPendingPayload {
  courseId: string
}

function parsePayload(raw: unknown): NotifyPendingPayload {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { courseId?: unknown }).courseId !== 'string'
  ) {
    throw new Error(
      'courseApproval.notifyPending: payload must be an object shaped { courseId: string }'
    )
  }
  return { courseId: (raw as { courseId: string }).courseId }
}

export function createCourseApprovalNotificationHandler(
  deps: CourseApprovalNotificationHandlerDependencies
): JobHandler {
  return async (rawPayload: unknown, context: JobContext): Promise<void> => {
    const { courseId } = parsePayload(rawPayload)

    // ADMIN-14 — no support address configured: nothing to send, logged so
    // an operator can see why, never a retry (this handler's own module
    // comment).
    if (!deps.supportContact) {
      deps.logger.info(
        { organizationId: context.organizationId, courseId },
        'apps/worker: SUPPORT_CONTACT is not configured — not sending a pending-course-approval notification'
      )
      return
    }

    const course = courses.getCourse(
      context.organizationId,
      courseId,
      context.db
    )
    if (!course) {
      // The course itself is gone (deleted) by the time this ran — nothing
      // left to notify anyone about.
      deps.logger.info(
        { organizationId: context.organizationId, courseId },
        'apps/worker: course no longer exists — not sending a pending-course-approval notification'
      )
      return
    }
    // An administrator approved it while the job sat in the queue — never
    // send a stale "still pending" notification (this handler's own module
    // comment).
    if (course.aiApprovedAt !== null) {
      deps.logger.info(
        { organizationId: context.organizationId, courseId },
        'apps/worker: course was approved before this notification ran — not sending it'
      )
      return
    }

    const project = projects.getProject(
      context.organizationId,
      course.projectId,
      context.db
    )
    const organization = organizations.getOrganizationById(
      context.organizationId,
      context.db
    )
    const ownerEmails = courseApproval.listActiveOwnerEmails(
      context.organizationId,
      context.db
    )

    const link = buildCourseApprovalConsoleLink(deps.publicAppUrl, courseId)
    const subject = `Course "${course.title}" is awaiting approval`
    const ownerLine =
      ownerEmails.length > 0 ? ownerEmails.join(', ') : 'none on record'
    const body =
      `A course is awaiting approval on Bloombot.\n\n` +
      `Course: ${course.title}\n` +
      `Project: ${project?.name ?? 'unknown project'}\n` +
      `Organization: ${organization?.name ?? 'unknown organization'}\n` +
      `Owner: ${ownerLine}\n\n` +
      `Review it here: ${link}\n`

    await deps.emailSender.send(deps.supportContact, subject, body)
  }
}
