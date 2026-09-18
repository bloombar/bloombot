/**
 * ADMIN-14 — the pending-course-approval notification's own link, built by
 * `buildCourseApprovalConsoleLink` (`src/course-approval-link.ts`'s own
 * module comment: the same "one place the URL is spelled out, exported, so
 * a test runs the same builder the deployment does" convention
 * `apps/api/src/sign-in-link.ts`'s `buildSignInLink` already follows).
 */

import { describe, expect, it } from 'vitest'

import { buildCourseApprovalConsoleLink } from '../src/course-approval-link.js'

const APP = 'https://bloombot.example'

describe('buildCourseApprovalConsoleLink (ADMIN-14)', () => {
  it('builds the exact console URL docs/SPEC.md §45 names', () => {
    expect(buildCourseApprovalConsoleLink(APP, 'course-1')).toBe(
      'https://bloombot.example/platform-admin/courses/course-1'
    )
  })

  // TEN-4 — the host comes from `publicAppUrl` alone, never a hard-coded
  // one.
  it('builds from whatever publicAppUrl is given, not a hard-coded host', () => {
    expect(
      buildCourseApprovalConsoleLink('https://other.example', 'course-2')
    ).toBe('https://other.example/platform-admin/courses/course-2')
  })
})
