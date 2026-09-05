/**
 * WEB-32/WEB-34: `parseRoute`/`buildPath`'s own round trip — every real
 * route variant survives `parseRoute(buildPath(route))` unchanged, and a
 * malformed or unknown path always lands on `'not-found'` rather than
 * throwing or silently guessing. `src/routing/route.ts`'s own module
 * comment has the fuller reasoning for why these two are exact inverses.
 */

import { describe, expect, it } from 'vitest'

import {
  buildPath,
  isSameCourseEditorScreen,
  parseRoute,
  type Route,
} from '../src/routing/route.js'

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
  // WEB-36 — a transcript link names a course, and optionally the one
  // person within it, directly in the address.
  { kind: 'transcripts', organizationId: 'org-1', courseId: 'course-1' },
  {
    kind: 'transcripts',
    organizationId: 'org-1',
    courseId: 'course-1',
    personId: 'person-1',
  },
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

  // WEB-35 (rework round 1, must-fix 7) — the literal-path block above only
  // ever asserted `.kind !== 'not-found'`, which would have stayed green
  // even if every one of these five parsed to the wrong tab, or if the
  // bare form's own novel decision (no tab segment names `'general'`,
  // rather than falling through to `'not-found'`) silently broke. Asserted
  // directly, against the whole parsed route, instead.
  it('a bare course address with no tab segment parses to the General tab', () => {
    expect(parseRoute('/o/org-1/projects/proj-1/courses/course-1')).toEqual({
      kind: 'course-editor',
      organizationId: 'org-1',
      projectId: 'proj-1',
      courseId: 'course-1',
      tab: 'general',
    })
  })

  it.each([
    ['general', 'general'],
    ['ai', 'ai'],
    ['discord', 'discord'],
    ['roster', 'roster'],
    ['people', 'people'],
  ] as const)(
    'a course address naming the %s tab parses to it',
    (segment, tab) => {
      expect(
        parseRoute(`/o/org-1/projects/proj-1/courses/course-1/${segment}`)
      ).toEqual({
        kind: 'course-editor',
        organizationId: 'org-1',
        projectId: 'proj-1',
        courseId: 'course-1',
        tab,
      })
    }
  )

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
    // WEB-35 (rework round 1, must-fix 4) — `new` is `new-course`'s own
    // reserved fourth segment (`parseRoute`'s own comment on why that rule
    // has to run first); a fifth, tab segment tacked onto it must not read
    // `new` as a literal course id instead — fails without the fix,
    // reaching `getCourse(org, 'new')`.
    '/o/org-1/projects/proj-1/courses/new/general',
    '/o/org-1/nope',
    // WEB-36 — a `personId` without a `courseId` names nothing meaningful
    // (`TranscriptsRoute`'s own comment on why); this scheme's segment
    // count never has a slot for one without the other, so this is really
    // just an unrecognised four-segment path, same as any other.
    '/o/org-1/transcripts/course-1/person-1/extra',
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

describe('isSameCourseEditorScreen (WEB-35, WEB-16)', () => {
  const BASE: Route = {
    kind: 'course-editor',
    organizationId: 'org-1',
    projectId: 'proj-1',
    courseId: 'course-1',
    tab: 'general',
  }

  it('is true for the same course, differing only in tab', () => {
    expect(isSameCourseEditorScreen(BASE, { ...BASE, tab: 'ai' })).toBe(true)
  })

  it('is false for a different course', () => {
    expect(
      isSameCourseEditorScreen(BASE, { ...BASE, courseId: 'course-2' })
    ).toBe(false)
  })

  it('is false for a different project or organization', () => {
    expect(
      isSameCourseEditorScreen(BASE, { ...BASE, projectId: 'proj-2' })
    ).toBe(false)
    expect(
      isSameCourseEditorScreen(BASE, { ...BASE, organizationId: 'org-2' })
    ).toBe(false)
  })

  it('is false when either side is not a course-editor route at all', () => {
    expect(
      isSameCourseEditorScreen(BASE, {
        kind: 'projects',
        organizationId: 'org-1',
      })
    ).toBe(false)
    expect(
      isSameCourseEditorScreen(
        { kind: 'projects', organizationId: 'org-1' },
        BASE
      )
    ).toBe(false)
  })
})
