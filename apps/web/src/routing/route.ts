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

/**
 * WEB-35 — the five named panes `pages/CourseEditor.tsx` renders for an
 * existing course, one per address segment. A bare `/courses/:courseId`
 * (no tab segment at all) parses to `'general'` — see `parseRoute`'s own
 * comment on that rule — but `buildPath` never relies on that default: it
 * always emits the explicit tab segment, so every address this app itself
 * constructs is the exact one that would parse back to it.
 *
 * The single source of truth for the five ids — the type below, the
 * runtime guard (`isCourseEditorTab`) and `pages/CourseEditor.tsx`'s own
 * tab bar (which maps this same array into id/label pairs) all derive from
 * this one array, rather than each spelling the five names out separately
 * (a rework finding: a sixth tab used to mean editing three places that
 * had to agree by hand).
 */
export const COURSE_EDITOR_TABS = [
  'general',
  'ai',
  'discord',
  'roster',
  'people',
] as const

export type CourseEditorTab = (typeof COURSE_EDITOR_TABS)[number]

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
      /** WEB-35 — always a concrete tab, never absent: `parseRoute` fills in `'general'` for a bare URL, so nothing downstream has to know the segment is optional. */
      tab: CourseEditorTab
    }

/**
 * WEB-36 — a transcript link from `components/CoursePeople.tsx` names both
 * the course and the person it points at, so the transcripts screen can
 * open with the right one already read rather than three empty pickers.
 * `personId` without a `courseId` is not a meaningful address (there is
 * nothing for it to filter) — deliberately unrepresentable, not merely
 * refused at parse time: the second variant is the only one that carries a
 * `personId` at all, and it requires `courseId` alongside it, so a caller
 * cannot construct the invalid pairing in the first place. The bare first
 * variant is this screen's own long-standing landing address, unchanged.
 */
export type TranscriptsRoute =
  | { kind: 'transcripts'; organizationId: string }
  | {
      kind: 'transcripts'
      organizationId: string
      courseId: string
      personId?: string
    }

/** WEB-32 — every other organization-scoped drawer destination `pages/Shell.tsx` renders directly, plus Chat, whose `courseId` is optional (no course chosen yet — `pages/Chat.tsx`'s own module comment on what that renders). */
export type OrganizationRoute =
  | ProjectsRoute
  | { kind: 'chat'; organizationId: string; courseId?: string }
  | TranscriptsRoute
  | { kind: 'discord'; organizationId: string }
  | { kind: 'team'; organizationId: string }
  | { kind: 'usage'; organizationId: string }
  | { kind: 'jobs'; organizationId: string }

/** WEB-34 — `/account` is deliberately not organization-scoped (the brief's own words); `pages/Shell.tsx` is the one place this and every `OrganizationRoute` below are ever rendered. */
export type AccountRoute = { kind: 'account' }

/** Every address `pages/Shell.tsx` can render — an organization-scoped screen, or the one account-level exception. */
export type ShellRoute = OrganizationRoute | AccountRoute

/**
 * WEB-33 — every address `pages/Admin.tsx` renders, under its own
 * `/platform-admin` prefix (deliberately distinct from `apps/api`'s own
 * `/admin` mount — `App.tsx`'s own module comment has why). `'platform-admin'`
 * itself is kept as the console's one entry point from outside the app — it
 * resolves to `'admin-organizations'` and replaces, the same "one-time
 * landing address, not somewhere back should return into" treatment `App.tsx`'s
 * own `'home'` already gets — while every address beneath it is a real,
 * bookmarkable screen `pages/Admin.tsx` navigates between with an ordinary
 * push.
 */
export type AdminRoute =
  | { kind: 'platform-admin' }
  | { kind: 'admin-organizations' }
  | { kind: 'admin-organization'; organizationId: string }
  | { kind: 'admin-deletions' }

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
  | AdminRoute
  | { kind: 'home' }
  | { kind: 'sign-in'; token: string }
  | { kind: 'discord-callback' }
  | { kind: 'connect'; organizationId: string }
  | { kind: 'join-link'; secret: string }
  | { kind: 'invitation'; secret: string }
  // The two published legal documents. Deliberately outside `ShellRoute` and
  // outside every signed-in tree: a privacy policy that needs an account to
  // read is not published, and Google's own OAuth review asks for one at a
  // public address.
  | { kind: 'privacy' }
  | { kind: 'terms' }
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

/** WEB-35 — a runtime guard for `CourseEditorTab`, since a URL segment is just a string until it is checked against the five names `pages/CourseEditor.tsx` actually renders; anything else (a typo, an old bookmark to a tab this app never had) is not a tab this scheme recognises, so `parseRoute` falls through to `'not-found'` rather than guessing. */
function isCourseEditorTab(segment: string): segment is CourseEditorTab {
  return (COURSE_EDITOR_TABS as readonly string[]).includes(segment)
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

  if (first === 'privacy' && segments.length === 1) return { kind: 'privacy' }
  if (first === 'terms' && segments.length === 1) return { kind: 'terms' }

  // WEB-33 — the admin console's own sub-addresses, `/platform-admin/...`.
  // `/platform-admin` alone (no `second` at all) is the console's one entry
  // point (`AdminRoute`'s own doc comment on why); everything else here
  // reads as a literal transcription of the brief's own scheme, the same
  // segment-count-first discipline the `/o/:organizationId/...` tree below
  // already holds itself to.
  if (first === 'platform-admin') {
    if (segments.length === 1) return { kind: 'platform-admin' }
    if (second === 'organizations' && rest.length === 0) {
      return { kind: 'admin-organizations' }
    }
    if (second === 'organizations' && rest.length === 1 && rest[0]) {
      return { kind: 'admin-organization', organizationId: rest[0] }
    }
    if (second === 'deletions' && rest.length === 0) {
      return { kind: 'admin-deletions' }
    }
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
    // WEB-35 — a bare `/courses/:courseId`, with no tab segment at all,
    // parses to the General tab: the natural reading of "no tab named" for
    // a screen that used to be one long form with no tabs at all, and the
    // one choice that keeps every pre-WEB-35 bookmark or link into this
    // address (there are no others — this scheme has always required all
    // four segments here) landing on a real screen rather than
    // `'not-found'`. `buildPath` never emits this shorter form itself (its
    // own comment on `CourseEditorTab`) — this rule exists for addresses
    // this app did not build, not ones it did.
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
        tab: 'general',
      }
    }
    // WEB-35 — the explicit form, one segment per tab, the only one
    // `buildPath` itself ever produces. `rest[3] !== 'new'` mirrors the
    // same exclusion the `new-course` rule above states directly (must-fix
    // 4, rework round 1): without it, `/courses/new/general` read `new` as
    // a literal course id — `rest[3]` is truthy, so nothing else here would
    // catch it — and reached `getCourse(org, 'new')` instead of
    // `'not-found'`.
    if (
      rest.length === 5 &&
      rest[0] === 'projects' &&
      rest[1] &&
      rest[2] === 'courses' &&
      rest[3] &&
      rest[3] !== 'new' &&
      // `rest[4] !== undefined` looks redundant next to `rest.length === 5`
      // above, but it is not dead: `noUncheckedIndexedAccess` types
      // `rest[4]` as `string | undefined` no matter how many earlier
      // conditions already guarantee an element is there at that index —
      // TS does not narrow an index expression's type across separate
      // conditions the way it narrows a plain variable, so
      // `isCourseEditorTab(rest[4])` alone does not typecheck without
      // this. Confirmed against this repo's own compiler settings
      // (`tsc --build`, not a bare `--noEmit` on one project's own
      // solution file, which checks nothing at all) rather than assumed.
      rest[4] !== undefined &&
      isCourseEditorTab(rest[4])
    ) {
      return {
        kind: 'course-editor',
        organizationId,
        projectId: rest[1],
        courseId: rest[3],
        tab: rest[4],
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
    // WEB-36 — a course, and optionally the one person within it, named
    // directly in the address (`TranscriptsRoute`'s own comment on why a
    // `personId` never appears without a `courseId`, here or anywhere else
    // in this scheme).
    if (rest.length === 2 && rest[0] === 'transcripts' && rest[1]) {
      return { kind: 'transcripts', organizationId, courseId: rest[1] }
    }
    if (rest.length === 3 && rest[0] === 'transcripts' && rest[1] && rest[2]) {
      return {
        kind: 'transcripts',
        organizationId,
        courseId: rest[1],
        personId: rest[2],
      }
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
// The ids interpolated below are never escaped, deliberately: every one of
// them is a server-generated UUID (`crypto.randomUUID()`, `@bloombot/db`'s
// own repos), so there is no URL-significant character for
// `encodeURIComponent` to escape, and escaping would only make the address
// bar harder to read for the ids this app actually builds. An id from
// anywhere else does not reach this function — an address a *visitor*
// typed goes through `parseRoute`, which never hands its segments back to
// `buildPath` without a matching route first.
export function buildPath(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '/'
    case 'account':
      return '/account'
    case 'privacy':
      return '/privacy'
    case 'terms':
      return '/terms'
    case 'platform-admin':
      return '/platform-admin'
    case 'admin-organizations':
      return '/platform-admin/organizations'
    case 'admin-organization':
      return `/platform-admin/organizations/${route.organizationId}`
    case 'admin-deletions':
      return '/platform-admin/deletions'
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
      // WEB-35 — always the explicit tab segment (`CourseEditorTab`'s own
      // comment on why): `route.tab` is never absent, so there is no
      // "default" case here to fall back to the shorter form `parseRoute`
      // also accepts.
      return `/o/${route.organizationId}/projects/${route.projectId}/courses/${route.courseId}/${route.tab}`
    case 'chat':
      return route.courseId === undefined
        ? `/o/${route.organizationId}/chat`
        : `/o/${route.organizationId}/chat/${route.courseId}`
    case 'transcripts':
      // WEB-36 — both `TranscriptsRoute` variants share `kind: 'transcripts'`
      // (`TranscriptsRoute`'s own comment on why `personId` alone is
      // unrepresentable), so a `switch` on `route.kind` alone does not
      // narrow between them — `'courseId' in route` does, the same way
      // `route.tab`'s absence is checked elsewhere in this file by testing
      // for the property rather than the (identical) `kind`.
      return 'courseId' in route
        ? route.personId === undefined
          ? `/o/${route.organizationId}/transcripts/${route.courseId}`
          : `/o/${route.organizationId}/transcripts/${route.courseId}/${route.personId}`
        : `/o/${route.organizationId}/transcripts`
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

/** WEB-33 — `App.tsx`'s own guard for whether `route` is one `pages/Admin.tsx` can render, the same "narrow before constructing the element" shape `isShellRoute` already gives `pages/Shell.tsx`. */
export function isAdminRoute(route: Route): route is AdminRoute {
  switch (route.kind) {
    case 'platform-admin':
    case 'admin-organizations':
    case 'admin-organization':
    case 'admin-deletions':
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

/**
 * WEB-35/WEB-16 — true when `a` and `b` are the same course editor screen,
 * differing at most in which tab is showing. `routing/useRoute.ts`'s own
 * `popstate` handler uses this to bypass the unsaved-changes guard for a
 * Back/Forward that only moves the tab: nothing on screen actually
 * unmounts for that move (`pages/CourseEditor.tsx` keeps every visited
 * tab's panel mounted, hidden, precisely so a tab switch is never a real
 * "leave"), so treating it as one produced a modal that lied — "Discard
 * changes" discarded nothing (there was nothing to discard), and "Keep
 * editing" stranded the reader on whichever tab the pop had already moved
 * the address to. This decision belongs here, next to the rest of what
 * this module already knows about a course editor's own address, rather
 * than inline in the hook, which has no other reason to know the shape of
 * a `course-editor` route at all.
 */
export function isSameCourseEditorScreen(a: Route, b: Route): boolean {
  return (
    a.kind === 'course-editor' &&
    b.kind === 'course-editor' &&
    a.organizationId === b.organizationId &&
    a.projectId === b.projectId &&
    a.courseId === b.courseId
  )
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
  // WEB-36 — `'transcripts'` is spelled out on its own, same as
  // `'account'` above: `TranscriptsRoute`'s own two variants no longer
  // share one shape (the second carries a required `courseId`), so the
  // generic `{ kind: tab, organizationId }` below no longer has a single
  // type it can be for every `Tab` — this is always the bare landing
  // address, never one naming a course.
  if (tab === 'transcripts') return { kind: 'transcripts', organizationId }
  return { kind: tab, organizationId }
}
