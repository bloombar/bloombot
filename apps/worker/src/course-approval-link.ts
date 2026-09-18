/**
 * ADMIN-14's own console link, following `apps/api/src/sign-in-link.ts`'s own
 * convention: the URL a deployment actually sends is spelled out once here,
 * exported, so `tests/course-approval-link.test.ts` runs the same builder
 * `handlers/course-approval-notifications.ts` does — a typo in the path
 * (`/platform-admin/courses/` misspelled, a missing id) would otherwise ship
 * green with every test building its own lookalike URL instead.
 *
 * TEN-4 — `publicAppUrl` is the only thing this builds the host from, never
 * a hard-coded one; `@bloombot/config`'s own `PUBLIC_APP_URL` already has its
 * trailing slash stripped centrally (`packages/config/src/env.ts`'s own
 * `stripTrailingSlashes` transform), so plain concatenation here is correct.
 */

/** ADMIN-9's own course console screen — `docs/SPEC.md` §45 names this exact path. */
export function buildCourseApprovalConsoleLink(
  publicAppUrl: string,
  courseId: string
): string {
  return `${publicAppUrl}/platform-admin/courses/${courseId}`
}
