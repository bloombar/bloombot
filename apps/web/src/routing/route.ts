/**
 * WEB-32/WEB-34: the canonical address for every signed-in screen this
 * panel renders, and the hand-rolled parser/builder pair that is the only
 * thing in `apps/web` allowed to know what one of these paths looks like —
 * `App.tsx`, `pages/Shell.tsx`, `pages/ProjectsPanel.tsx` and
 * `pages/Chat.tsx` all read and write addresses through `parseRoute`/
 * `buildPath` alone, never a hand-concatenated template string of their
 * own, the same "nothing in the app ever hand-concatenates a path" the
 * brief for this slice states directly. No router library — `App.tsx`'s
 * own former module comment already gave the reasoning for that
 * ("a shell this small does not need one"), unchanged by this slice; this
 * module is what replaces the regex-per-path checks that comment used to
 * describe.
 *
 * `Route` is a discriminated union on `kind`, one variant per address in
 * the brief's own URL scheme plus `'not-found'` — the same shape `App.tsx`'s
 * own (now retired) `SessionState` already used one level up, and the same
 * "switch on a `kind`, never on a raw string" discipline this codebase
 * already holds itself to elsewhere (`pages/ProjectsPanel.tsx`'s own
 * `View`, before this slice).
 *
 * `parseRoute`/`buildPath` are exact inverses for every named variant —
 * `tests/routing.test.ts` proves the round trip for each one — with one
 * asymmetry, by design: `buildPath({ kind: 'not-found' })` returns a path
 * that itself parses back to `'not-found'` (nothing else claims it), but
 * `'not-found'` is never a path this module *expects* to be built from a
 * real navigation — nothing in this app ever asks to go there on purpose;
 * it is what `parseRoute` returns for a pathname none of the rules below
 * recognise. It still has to build to *something* for the round-trip
 * property to hold uniformly across every variant, without a special case
 * carved out for the one kind that is not really an address.
 */

/** WEB-32 — an organization-scoped screen inside `pages/ProjectsPanel.tsx`; a deep link only ever carries the ids the address itself names (a `projectId`, a `courseId`), never the whole record — `pages/ProjectsPanel.tsx`'s own module comment has how those ids are resolved into the `Project`/`Course` the screens underneath actually take. */
export type ProjectsRoute =
  | { kind: 'projects'; organizationId: string }
  | { kind: 'project-courses'; organizationId: string; projectId: string }
  | { kind: 'new-course'; organizationId: string; projectId: string }
  | {
      kind: 'course-editor'
      organizationId: string
      projectId: string
      courseId: string
    }

/** WEB-32 — every other organization-scoped drawer destination `pages/Shell.tsx` renders directly, plus Chat, whose `courseId` is optional (no course chosen yet — `pages/Chat.tsx`'s own module comment on what that renders). */
export type OrganizationRoute =
  | ProjectsRoute
  | { kind: 'chat'; organizationId: string; courseId?: string }
  | { kind: 'transcripts'; organizationId: string }
  | { kind: 'discord'; organizationId: string }
  | { kind: 'team'; organizationId: string }
  | { kind: 'usage'; organizationId: string }
  | { kind: 'jobs'; organizationId: string }

/** WEB-34 — `/account` is deliberately not organization-scoped (the brief's own words); `pages/Shell.tsx` is the one place this and every `OrganizationRoute` below are ever rendered. */
export type AccountRoute = { kind: 'account' }

/** Every address `pages/Shell.tsx` can render — an organization-scoped screen, or the one account-level exception. */
export type ShellRoute = OrganizationRoute | AccountRoute

/**
 * Every address this whole app can be asked to render, signed in or out.
 * The five below `ShellRoute` are unchanged by this slice (`App.tsx`'s own
 * module comment on why: a one-time entry point, never somewhere "back"
 * should return into) — folded into this one union anyway, so `App.tsx`
 * switches on `route.kind` throughout rather than mixing that with raw
 * `pathname` string comparisons for some paths and not others.
 */
export type Route =
  | ShellRoute
  | { kind: 'home' }
  | { kind: 'sign-in'; token: string }
  | { kind: 'discord-callback' }
  | { kind: 'connect'; organizationId: string }
  | { kind: 'join-link'; secret: string }
  | { kind: 'invitation'; secret: string }
  | { kind: 'platform-admin' }
  | { kind: 'not-found' }

/**
 * `pathname.split('/')` with the empty segments a leading, trailing or
 * doubled slash produces filtered out — `/o/x/projects` and `/o/x/projects/`
 * parse identically, which costs nothing here and is one fewer way for a
 * hand-typed or bookmarked address to land on `'not-found'` for a reason
 * nobody would guess.
 */
function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0)
}

/**
 * WEB-32 — the parser half: a pathname to a `Route`. Every rule below reads
 * as a literal transcription of the brief's own URL scheme, matched by
 * segment count and literal segments rather than one combined regular
 * expression — `new-course`'s own `/courses/new` has to be checked before
 * `course-editor`'s `/courses/:courseId` (`new` would otherwise parse as a
 * course id), and segment-count-first makes that ordering obvious rather
 * than relying on regex alternation order to get it right silently.
 * Anything this function does not recognise — including every id segment
 * that came out empty, already filtered above — falls through to
 * `'not-found'`, never a `TypeError` or an unhandled variant.
 */
export function parseRoute(pathname: string): Route {
  const segments = segmentsOf(pathname)

  if (segments.length === 0) return { kind: 'home' }

  const [first, second, ...rest] = segments

  if (first === 'account' && segments.length === 1) return { kind: 'account' }
  if (first === 'platform-admin' && segments.length === 1) {
    return { kind: 'platform-admin' }
  }
  if (first === 'discord' && second === 'callback' && segments.length === 2) {
    return { kind: 'discord-callback' }
  }
  if (first === 'sign-in' && segments.length === 2 && second) {
    return { kind: 'sign-in', token: second }
  }
  if (first === 'connect' && segments.length === 2 && second) {
    return { kind: 'connect', organizationId: second }
  }
  if (first === 'join' && segments.length === 2 && second) {
    return { kind: 'join-link', secret: second }
  }
  if (first === 'invitations' && segments.length === 2 && second) {
    return { kind: 'invitation', secret: second }
  }

  // WEB-32's own organization-scoped tree: `/o/:organizationId/...`.
  if (first === 'o' && second) {
    const organizationId = second
    if (rest.length === 1 && rest[0] === 'projects') {
      return { kind: 'projects', organizationId }
    }
    if (rest.length === 2 && rest[0] === 'projects' && rest[1]) {
      return { kind: 'project-courses', organizationId, projectId: rest[1] }
    }
    if (
      rest.length === 4 &&
      rest[0] === 'projects' &&
      rest[1] &&
      rest[2] === 'courses' &&
      rest[3] === 'new'
    ) {
      return { kind: 'new-course', organizationId, projectId: rest[1] }
    }
    if (
      rest.length === 4 &&
      rest[0] === 'projects' &&
      rest[1] &&
      rest[2] === 'courses' &&
      rest[3]
    ) {
      return {
        kind: 'course-editor',
        organizationId,
        projectId: rest[1],
        courseId: rest[3],
      }
    }
    if (rest.length === 1 && rest[0] === 'chat') {
      return { kind: 'chat', organizationId }
    }
    if (rest.length === 2 && rest[0] === 'chat' && rest[1]) {
      return { kind: 'chat', organizationId, courseId: rest[1] }
    }
    if (rest.length === 1 && rest[0] === 'transcripts') {
      return { kind: 'transcripts', organizationId }
    }
    if (rest.length === 1 && rest[0] === 'discord') {
      return { kind: 'discord', organizationId }
    }
    if (rest.length === 1 && rest[0] === 'team') {
      return { kind: 'team', organizationId }
    }
    if (rest.length === 1 && rest[0] === 'usage') {
      return { kind: 'usage', organizationId }
    }
    if (rest.length === 1 && rest[0] === 'jobs') {
      return { kind: 'jobs', organizationId }
    }
  }

  return { kind: 'not-found' }
}

/**
 * WEB-32 — the builder half, `parseRoute`'s exact inverse: nothing in this
 * app hand-concatenates a path, it builds a `Route` value and calls this.
 */
export function buildPath(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '/'
    case 'account':
      return '/account'
    case 'platform-admin':
      return '/platform-admin'
    case 'discord-callback':
      return '/discord/callback'
    case 'sign-in':
      return `/sign-in/${route.token}`
    case 'connect':
      return `/connect/${route.organizationId}`
    case 'join-link':
      return `/join/${route.secret}`
    case 'invitation':
      return `/invitations/${route.secret}`
    case 'projects':
      return `/o/${route.organizationId}/projects`
    case 'project-courses':
      return `/o/${route.organizationId}/projects/${route.projectId}`
    case 'new-course':
      return `/o/${route.organizationId}/projects/${route.projectId}/courses/new`
    case 'course-editor':
      return `/o/${route.organizationId}/projects/${route.projectId}/courses/${route.courseId}`
    case 'chat':
      return route.courseId === undefined
        ? `/o/${route.organizationId}/chat`
        : `/o/${route.organizationId}/chat/${route.courseId}`
    case 'transcripts':
      return `/o/${route.organizationId}/transcripts`
    case 'discord':
      return `/o/${route.organizationId}/discord`
    case 'team':
      return `/o/${route.organizationId}/team`
    case 'usage':
      return `/o/${route.organizationId}/usage`
    case 'jobs':
      return `/o/${route.organizationId}/jobs`
    // Never actually navigated to on purpose (this file's own module
    // comment) — a path that itself parses back to `'not-found'`, which is
    // all the round-trip property above needs from it.
    case 'not-found':
      return '/not-found'
  }
}

/** `App.tsx`'s own guard for whether `route` is one `pages/Shell.tsx` can render at all, before it ever constructs the `<Shell>` element — the org id (or account) accessibility check that decides *between* rendering it and a not-found screen lives in `App.tsx` itself, since it needs the signed-in account's own memberships to answer. */
export function isShellRoute(route: Route): route is ShellRoute {
  switch (route.kind) {
    case 'projects':
    case 'project-courses':
    case 'new-course':
    case 'course-editor':
    case 'chat':
    case 'transcripts':
    case 'discord':
    case 'team':
    case 'usage':
    case 'jobs':
    case 'account':
      return true
    default:
      return false
  }
}

/** `pages/ProjectsPanel.tsx`'s own guard for the four routes it renders, narrowing `ShellRoute` down to `ProjectsRoute` the same way `isShellRoute` narrows `Route`. */
export function isProjectsRoute(route: Route): route is ProjectsRoute {
  switch (route.kind) {
    case 'projects':
    case 'project-courses':
    case 'new-course':
    case 'course-editor':
      return true
    default:
      return false
  }
}

/** The drawer tab a `ShellRoute` belongs under (`pages/Shell.tsx`'s own `navGroups`) — every `ProjectsRoute` variant collapses to `'projects'`, matching `pages/ProjectsPanel.tsx`'s own single entry in that drawer. */
export type Tab =
  | 'discord'
  | 'projects'
  | 'chat'
  | 'transcripts'
  | 'usage'
  | 'team'
  | 'jobs'
  | 'account'

export function tabForRoute(route: ShellRoute): Tab {
  if (isProjectsRoute(route)) return 'projects'
  return route.kind
}

/**
 * The inverse of `tabForRoute` for the four tabs that are exactly one
 * address each — every `ProjectsRoute` variant besides plain `'projects'`
 * carries an id nothing outside `pages/ProjectsPanel.tsx` itself has a
 * reason to name, so this only ever builds the tab's own landing address.
 * `pages/Shell.tsx` uses this everywhere a click or an organization switch
 * needs to land on "this tab, this organization" with no further id in
 * mind — a nav item, the home control, switching organizations away from a
 * screen with no counterpart in the new one (`pages/Shell.tsx`'s own module
 * comment on that rule).
 */
export function routeForTab(tab: Tab, organizationId: string): ShellRoute {
  if (tab === 'account') return { kind: 'account' }
  return { kind: tab, organizationId }
}
