/**
 * Test helper: approve a course directly in the e2e database (COST-8).
 *
 * Every course this suite's specs create goes through the ordinary panel
 * flow, as an ordinary signed-in account in an ordinary (non-administrator-
 * owned) organization — `support/sign-in.ts` never sets `ADMIN_EMAILS` to
 * the address a spec signs in as — so COST-8's gate leaves every one of
 * them pending by default, exactly as it would in production. A spec whose
 * whole point is exercising chatting/answering, not the approval gate
 * itself, calls this once after creating its course, the same "seed the
 * one fact the panel has no screen for yet" pattern `chat.spec.ts`'s own
 * module comment already uses for enrolment — not a production bypass:
 * this writes through the identical `@bloombot/db#courseApproval.approveCourse`
 * a platform administrator's own WEB-53 action will call, against the e2e
 * database directly, the same way every other spec's own `openDatabase(E2E_DATABASE_PATH)`
 * seeding already does.
 */

import { courseApproval, type Database } from '@bloombot/db'

export function approveCourseForE2e(
  db: Database,
  organizationId: string,
  courseId: string
): void {
  courseApproval.approveCourse(
    organizationId,
    courseId,
    null,
    'approve',
    Date.now(),
    db
  )
}
