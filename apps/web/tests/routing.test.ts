/**
 * WEB-32/WEB-34: `parseRoute`/`buildPath`'s own round trip — every real
 * route variant survives `parseRoute(buildPath(route))` unchanged, and a
 * malformed or unknown path always lands on `'not-found'` rather than
 * throwing or silently guessing. `src/routing/route.ts`'s own module
 * comment has the fuller reasoning for why these two are exact inverses.
 */

import { describe, expect, it } from 'vitest'

import { buildPath, parseRoute, type Route } from '../src/routing/route.js'

// One example of every named variant — `'not-found'` is deliberately not
// here (this file's own module comment on `route.ts` explains why it is
// not really an address); it gets its own assertions below instead.
const ROUTES: Route[] = [
  { kind: 'home' },
  { kind: 'account' },
  { kind: 'platform-admin' },
  { kind: 'admin-organizations' },
  { kind: 'admin-organization', organizationId: 'org-1' },
  { kind: 'admin-deletions' },
  { kind: 'discord-callback' },
  { kind: 'sign-in', token: 'tok_abc123' },
  { kind: 'connect', organizationId: 'org-1' },
  { kind: 'join-link', secret: 'secret-abc' },
  { kind: 'invitation', secret: 'secret-def' },
  { kind: 'projects', organizationId: 'org-1' },
  { kind: 'project-courses', organizationId: 'org-1', projectId: 'proj-1' },
  { kind: 'new-course', organizationId: 'org-1', projectId: 'proj-1' },
  // WEB-35 — one example per course-editor tab, so the round-trip property
  // holds for each of the five, not just whichever one happened to be
  // written down before tabs existed.
  {
    kind: 'course-editor',
    organizationId: 'org-1',
    projectId: 'proj-1',
    courseId: 'course-1',
    tab: 'general',
  },
  {
    kind: 'course-editor',
    organizationId: 'org-1',
    projectId: 'proj-1',
    courseId: 'course-1',
    tab: 'ai',
  },
  {
    kind: 'course-editor',
    organizationId: 'org-1',
    projectId: 'proj-1',
    courseId: 'course-1',
    tab: 'discord',
  },
  {
    kind: 'course-editor',
    organizationId: 'org-1',
    projectId: 'proj-1',
    courseId: 'course-1',
    tab: 'roster',
  },
  {
    kind: 'course-editor',
    organizationId: 'org-1',
    projectId: 'proj-1',
    courseId: 'course-1',
    tab: 'people',
  },
  { kind: 'chat', organizationId: 'org-1' },
  { kind: 'chat', organizationId: 'org-1', courseId: 'course-1' },
  { kind: 'transcripts', organizationId: 'org-1' },
  { kind: 'discord', organizationId: 'org-1' },
  { kind: 'team', organizationId: 'org-1' },
  { kind: 'usage', organizationId: 'org-1' },
  { kind: 'jobs', organizationId: 'org-1' },
]

describe('routing/route.ts (WEB-32, WEB-34)', () => {
  it.each(ROUTES)('round-trips %o through buildPath -> parseRoute', (route) => {
    expect(parseRoute(buildPath(route))).toEqual(route)
  })

  it('buildPath(not-found) itself parses back to not-found', () => {
    expect(parseRoute(buildPath({ kind: 'not-found' }))).toEqual({
      kind: 'not-found',
    })
  })

  it.each([
    '/',
    '/o/org-1/projects',
    '/o/org-1/projects/',
    '/o/org-1/projects/proj-1',
    '/o/org-1/projects/proj-1/courses/new',
    // WEB-35 — the bare form (no tab segment) and the explicit form both
    // parse to a real screen; see `route.ts`'s own comment on why the bare
    // one lands on the General tab rather than `'not-found'`.
    '/o/org-1/projects/proj-1/courses/course-1',
    '/o/org-1/projects/proj-1/courses/course-1/general',
    '/o/org-1/projects/proj-1/courses/course-1/ai',
    '/o/org-1/projects/proj-1/courses/course-1/discord',
    '/o/org-1/projects/proj-1/courses/course-1/roster',
    '/o/org-1/projects/proj-1/courses/course-1/people',
    '/o/org-1/chat',
    '/o/org-1/chat/course-1',
    '/account',
    '/platform-admin',
    '/platform-admin/organizations',
    '/platform-admin/organizations/org-1',
    '/platform-admin/deletions',
  ])('parses the exact literal path %s', (path) => {
    expect(parseRoute(path).kind).not.toBe('not-found')
  })

  it.each([
    '/nonsense',
    '/o',
    '/o/',
    '/o/org-1',
    '/o/org-1/',
    '/o//projects',
    '/o/org-1/projects/proj-1/courses',
    '/o/org-1/projects/proj-1/courses/',
    // WEB-35 — an unrecognised tab name is not a tab this scheme has, the
    // same "falls through to not-found rather than guessing" rule every
    // other unknown segment already gets.
    '/o/org-1/projects/proj-1/courses/course-1/nonsense',
    '/o/org-1/nope',
    '/sign-in',
    '/sign-in/',
    '/connect',
    '/join',
    '/invitations',
    '/account/extra',
    '/platform-admin/sub',
    '/platform-admin/organizations/org-1/extra',
    '/platform-admin/deletions/extra',
  ])('malformed or unknown path %s lands on not-found', (path) => {
    expect(parseRoute(path)).toEqual({ kind: 'not-found' })
  })
})
