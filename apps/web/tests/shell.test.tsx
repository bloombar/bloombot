/**
 * `pages/Shell.tsx` (WEB-3, WEB-4): which organization the panel is acting
 * in, and that the actively selected organization — not merely whichever one
 * the component happened to mount with — is what every subsequent request
 * carries. Before this file existed there was no test at all for `Shell.tsx`
 * (finding 2 of the WEB-1..6 rework): WEB-3's central claim went untested,
 * and `tests/organization-switcher.test.tsx` explicitly defers "what active
 * means" to this component.
 *
 * WEB-32/WEB-34 — `Shell` no longer owns `activeOrganizationId`/`activeTab`
 * as local state; both are derived from the `route` prop this file's own
 * `renderShell` helper (below) now supplies, with a tiny in-test `navigate`
 * that updates it the same way `routing/useRoute.ts` would in the real app
 * (this file does not need a real `window.history` round trip — that is
 * `tests/routing.test.ts`'s own job, and `e2e/`'s for the browser address
 * bar itself). The tests that used to prove *which* organization a fresh
 * mount opens on (an install, a redeemed join link, the plain "first
 * membership" default) moved to `tests/app.test.tsx` — that choice is
 * `App.tsx`'s own `resolveHomeRoute` now, not anything this component
 * decides; `renderShell`'s own default `route` picks a fixed, deterministic
 * screen instead, matching what `resolveHomeRoute` would already choose
 * for the accounts below with no `justInstalled`/`joinedCourse` in play.
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'

import { ApiError } from '../src/api/client.js'
import type {
  AccountSummary,
  CourseSummary,
  Project,
} from '../src/api/types.js'
import { Shell, type ShellProps } from '../src/pages/Shell.js'
import {
  isShellRoute,
  type Route,
  type ShellRoute,
} from '../src/routing/route.js'
import { renderWithModal, withModal } from './helpers/render-with-modal.js'

/**
 * WEB-32 — mounts `Shell` behind a tiny stateful wrapper standing in for
 * `App.tsx`'s own `useRoute()`: `navigate` updates the wrapper's own `route`
 * state exactly the way a real navigation would, so every existing
 * "click a nav item, assert what renders" test in this file keeps working
 * unchanged. Defaults to Projects under the first membership (or Chat under
 * the first connected organization, for an account with none) when no
 * `route` is given — the same screen `App.tsx`'s own `resolveHomeRoute`
 * picks for an account with no `justInstalled`/`joinedCourse` in play,
 * which is the only case any test in this file still needs Shell itself to
 * decide anything about.
 */
function renderShell(
  props: Omit<ShellProps, 'route' | 'navigate'> & {
    route?: ShellRoute
    /**
     * WEB-59 — an optional spy over every `navigate()` call this render
     * makes, including one `isShellRoute` filters out of `route` itself
     * (`{ kind: 'platform-admin' }` — `Shell` never renders the console, so
     * the guard below leaves `route` untouched for it) — most of this
     * file's own tests do not care what was *attempted*, only what actually
     * rendered.
     */
    onNavigate?: (route: Route) => void
  }
) {
  const account = props.account
  const defaultOrganizationId =
    account.memberships[0]?.organizationId ??
    account.connectedOrganizations[0]?.organizationId ??
    ''
  const defaultIsMember = account.memberships.some(
    (membership) => membership.organizationId === defaultOrganizationId
  )
  const initialRoute: ShellRoute =
    props.route ??
    (defaultIsMember
      ? { kind: 'projects', organizationId: defaultOrganizationId }
      : { kind: 'chat', organizationId: defaultOrganizationId })

  function Harness() {
    const [route, setRoute] = useState<ShellRoute>(initialRoute)
    const navigate = (next: Route) => {
      props.onNavigate?.(next)
      // `Shell` only ever constructs a `ShellRoute` itself — this mirrors
      // `App.tsx`'s own guard (`isShellRoute`) rather than assuming it.
      if (isShellRoute(next)) setRoute(next)
    }
    return <Shell {...props} route={route} navigate={navigate} />
  }

  return renderWithModal(<Harness />)
}

// `listProjects`/`listCourses` are mocked here too, not just
// `dispatchAction` — finding 10 of the WEB-7 rework changed `activeTab`'s
// default to 'projects' (this module's own comment, `docs/DECISIONS.md`
// D-25), so `ProjectsPanel` (and, once a project is opened, `Courses`) now
// mounts on every one of this file's tests, not only the ones that opt into
// the Projects tab. `listDiscordServers` (TEN-8) is mocked the same way —
// `Shell.tsx` now reads it on every mount, not only once the Discord tab is
// opened, so every test in this file needs some resolved value or its own
// `.then` throws on an unmocked `vi.fn()`'s bare `undefined` return, the
// same reasoning `listProjects`'s own default already documents.
const {
  beginDiscordInstall,
  dispatchAction,
  signOut,
  listProjects,
  listCourses,
  listChatCourses,
  getChatMessages,
  listDiscordServers,
  fetchOrganizationUsage,
  listMemberships,
  listJobs,
} = vi.hoisted(() => ({
  beginDiscordInstall: vi.fn(),
  dispatchAction: vi.fn(),
  signOut: vi.fn(),
  listProjects: vi.fn(),
  listCourses: vi.fn(),
  listChatCourses: vi.fn(),
  getChatMessages: vi.fn(),
  listDiscordServers: vi.fn(),
  fetchOrganizationUsage: vi.fn(),
  listMemberships: vi.fn(),
  listJobs: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    beginDiscordInstall,
    dispatchAction,
    signOut,
    listProjects,
    listCourses,
    listChatCourses,
    getChatMessages,
    listDiscordServers,
    fetchOrganizationUsage,
    listMemberships,
    listJobs,
  }
})

// WEB-29: every nav item this file exercises (Discord/Projects/Chat/
// Transcripts/Usage/Team/Jobs, plus Sign out) now lives inside the drawer,
// not a header row visible at every width — a click needs the hamburger
// opened first. The drawer closes itself once an item is clicked
// (`AppShell.tsx`'s own `closeDrawer` call alongside `item.onClick`), so
// this is called again before every subsequent nav click in the same test,
// not only the first.
function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }))
}

// WEB-56 — the header's own organization control is a real menu now, not a
// `<select>` (`components/OrganizationSwitcher.tsx`'s own module comment):
// open it (the one button inside `organization-switcher` while it is
// closed), then click the named organization's own item. Every "switch
// organization" step in this file used to be one `fireEvent.change` against
// a `combobox` named "Organization" — replaced here, once, rather than at
// each of this file's own many call sites.
function switchOrganization(organizationName: string) {
  fireEvent.click(
    within(screen.getByTestId('organization-switcher')).getByRole('button')
  )
  // A prefix match, not an exact one — each item's own accessible name also
  // carries its role or "(connected)" after the name (this file's own
  // fixtures never share a common prefix, so this never matches more than
  // one item).
  fireEvent.click(
    screen.getByRole('button', { name: new RegExp(`^${organizationName}`) })
  )
}

const MULTI_MEMBERSHIP_ACCOUNT: AccountSummary = {
  id: 'account-1',
  email: 'instructor@example.edu',
  isPlatformAdministrator: false,
  memberships: [
    { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' },
    {
      organizationId: 'org-2',
      organizationName: 'Org Two',
      role: 'assistant',
    },
  ],
  connectedOrganizations: [],
}

// LINK-10: an account with its own personal organization (a membership, as
// every account has — TEN-1) and a *connected* person in a second
// organization it does not administer — a student who connected into the
// institution running their course, exactly the shape this file's own new
// `describe` block below exercises.
const CONNECTED_NON_MEMBER_ACCOUNT: AccountSummary = {
  id: 'account-2',
  email: 'student@example.edu',
  isPlatformAdministrator: false,
  memberships: [
    {
      organizationId: 'personal-org',
      organizationName: 'Student',
      role: 'owner',
    },
  ],
  connectedOrganizations: [
    { organizationId: 'institution-org', organizationName: 'A University' },
  ],
}

// WEB-41 — exactly one option total (one membership, no connections), so
// the header's own `OrganizationSwitcher` renders the plain-text,
// single-organization case (a link, as of this slice) rather than the
// `<select>` `MULTI_MEMBERSHIP_ACCOUNT`/`CONNECTED_NON_MEMBER_ACCOUNT`
// above both exercise.
const SINGLE_MEMBERSHIP_ACCOUNT: AccountSummary = {
  id: 'account-3',
  email: 'owner@example.edu',
  isPlatformAdministrator: false,
  memberships: [
    { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' },
  ],
  connectedOrganizations: [],
}

beforeEach(() => {
  // The default `ProjectsPanel` mount on every test (finding 10's new
  // 'projects' default) needs *some* resolved value, or `Projects.tsx`'s
  // own `.then` on an unmocked `vi.fn()`'s `undefined` return throws.
  // Individual tests override this where the response matters.
  listProjects.mockResolvedValue([])
  listCourses.mockResolvedValue([])
  // No binding by default — individual tests below override this where the
  // fetched install state is what they are actually testing (TEN-8).
  listDiscordServers.mockResolvedValue([])
  // The connected-only organization's own Chat tab (LINK-10's own `describe`
  // block below) needs at least one course to render its full screen,
  // heading included — `pages/Chat.tsx`'s own "not enrolled in a course
  // here yet" branch has no heading at all.
  listChatCourses.mockImplementation((organizationId: string) =>
    Promise.resolve(
      organizationId === 'institution-org'
        ? [{ id: 'course-1', title: 'A Course' }]
        : []
    )
  )
  // `Chat.tsx` fetches this once a course is selected — an unmocked
  // `vi.fn()` returning `undefined` would throw on `.then`, the same
  // reason `listProjects`/`listCourses` default above. Individual tests
  // override this where the transcript itself is what they are testing.
  // Must-fix 3 (review) — this used to resolve to a bare `[]`, the shape
  // `getChatMessages` returned before WEB-65 added `studentName` alongside
  // `messages`; `Chat.tsx#loadMessages` reads `result.messages`, which is
  // `undefined` off a bare array, so every test in this file left `Chat`
  // stuck in its own loading skeleton forever without any of them
  // asserting on the thread to notice.
  getChatMessages.mockResolvedValue({ messages: [], studentName: 'Jordan' })
})

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('Shell (WEB-3, WEB-4)', () => {
  // WEB-25/WEB-32, moved here from `tests/chat.test.tsx` (review finding):
  // the invariant is "the join-confirmation banner names the *joined*
  // course, never whichever one is merely selected", and since WEB-32 it is
  // enforced by `Shell` — it passes `joinConfirmation` to `Chat` only while
  // `route.courseId` still names the course the redemption resolved. The
  // test that used to guard it reproduced that same condition inside its own
  // wrapper component, so it held by construction and stayed green with the
  // real gate deleted. Driven through `Shell` here instead: deleting the
  // `route.courseId === joinedCourse.courseId` clause from `Shell.tsx` makes
  // this fail, which is the whole point of it.
  it('the join-confirmation banner is dropped once the reader selects a different course, rather than following them and naming the wrong one (WEB-25)', async () => {
    listChatCourses.mockResolvedValue([
      { id: 'course-1', title: 'Intro to Testing' },
      { id: 'course-2', title: 'Advanced Testing' },
    ])

    renderShell({
      account: CONNECTED_NON_MEMBER_ACCOUNT,
      onSignedOut: vi.fn(),
      joinedCourse: {
        organizationId: 'institution-org',
        courseId: 'course-2',
        alreadyEnrolled: false,
      },
      route: {
        kind: 'chat',
        organizationId: 'institution-org',
        courseId: 'course-2',
      },
    })

    const banner = await screen.findByTestId('join-confirmation')
    expect(banner).toHaveTextContent("You're enrolled in Advanced Testing.")

    fireEvent.change(await screen.findByRole('combobox', { name: 'Course' }), {
      target: { value: 'course-1' },
    })

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Course' })).toHaveValue(
        'course-1'
      )
    })
    expect(screen.queryByTestId('join-confirmation')).not.toBeInTheDocument()
  })

  // WEB-32/WEB-34 (review finding) — a connected-only account is forced to
  // Chat for an organization-scoped screen it cannot see, and the *address*
  // is corrected to match rather than left naming a screen that is not on
  // display. Rendered directly rather than through `renderShell`, so the
  // `navigate` this asserts on is a spy: the harness's own `navigate` only
  // moves its state, and the correction is precisely a call `Shell` makes
  // rather than a screen it renders.
  it('an address naming a screen a connected-only account cannot see is replaced with the chat address it actually renders', async () => {
    const navigate = vi.fn()

    renderWithModal(
      <Shell
        account={CONNECTED_NON_MEMBER_ACCOUNT}
        onSignedOut={vi.fn()}
        route={{
          kind: 'organization-settings',
          organizationId: 'institution-org',
          tab: 'discord',
        }}
        navigate={navigate}
      />
    )

    expect(await screen.findByTestId('chat-screen')).toBeInTheDocument()
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        { kind: 'chat', organizationId: 'institution-org' },
        { replace: true }
      )
    })
  })

  it('carries the actively selected organization into every request, not the one Shell mounted with (WEB-3)', async () => {
    beginDiscordInstall.mockResolvedValue({
      authorizationUrl: 'https://discord.test/oauth2/authorize?state=abc',
      expiresAt: Date.now() + 60_000,
    })
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    })

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    openDrawer()
    fireEvent.click(
      screen.getByRole('button', { name: 'Organization settings' })
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Discord' }))

    // Switch away from the organization this mounted with...
    switchOrganization('Org Two')
    // ...which remounts the whole settings screen (`pages/Shell.tsx`'s own
    // `key={activeOrganizationId}`) — landing back on its first tab,
    // General, not Discord (`docs/DECISIONS.md` on why this rework left it
    // that way); reopen it before the assertion below needs it.
    fireEvent.click(await screen.findByRole('tab', { name: 'Discord' }))
    // ...and begin an install. If Shell carried the *initial* organization
    // into this request instead of the actively selected one, this would
    // call beginDiscordInstall with 'org-1' — exactly the class of bug
    // WEB-3 exists to rule out ("cannot act in one while believing they are
    // in the other"). `findByRole`, not `getByRole` (TEN-8): neither org-1
    // nor org-2 carries a `justInstalled` value here, so the button only
    // appears once `listDiscordServers` resolves — this app no longer
    // renders it optimistically.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Install to Discord' })
    )

    await vi.waitFor(() =>
      expect(beginDiscordInstall).toHaveBeenCalledWith('org-2')
    )
  })

  it('removing an installed server dispatches against the actively selected organization', async () => {
    dispatchAction.mockResolvedValue({ result: undefined })

    // WEB-32 — the Discord tab for org-2 is the address this mounts on
    // directly, rather than relying on `justInstalled` to have picked
    // org-2 as the active organization (that is `App.tsx`'s own
    // `resolveHomeRoute` job now, this file's own module comment above).
    renderShell({
      account: MULTI_MEMBERSHIP_ACCOUNT,
      justInstalled: { organizationId: 'org-2', serverId: 'guild-42' },
      onSignedOut: vi.fn(),
      route: {
        kind: 'organization-settings',
        organizationId: 'org-2',
        tab: 'discord',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    // WEB-15: destructive, so it confirms first (`components/modal/`).
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await vi.waitFor(() =>
      expect(dispatchAction).toHaveBeenCalledWith(
        'org-2',
        'discordServers.remove',
        { serverId: 'guild-42' }
      )
    )
    // The banner clears once the remove succeeds.
    expect(
      await screen.findByRole('button', { name: 'Install to Discord' })
    ).toBeInTheDocument()
  })

  it('a sign-out that fails to round-trip still signs the caller out of this screen, without an unhandled rejection', async () => {
    signOut.mockRejectedValue(new ApiError(0, { error: 'network_error' }))
    const onSignedOut = vi.fn()

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut })
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    // If `handleSignOut`'s `try/finally` had no `catch` (finding 3 of the
    // WEB-1..6 rework), the rejection from `signOut()` would propagate past
    // `finally` with nowhere to land — Vitest reports that as a test
    // failure in its own right, on top of this assertion.
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1))
  })

  // WEB-16 rework — a reviewer's own finding: every other navigation this
  // shell starts (the nav row, the home control, the organization switcher)
  // already goes through `guardedNavigate`; Sign out did not, so half-filling
  // a course and clicking Sign out lost it with no prompt at all, while
  // clicking the Discord tab two inches away did prompt.
  it('signing out with a dirty course form open prompts, the same as any other navigation this shell starts', async () => {
    const projectOrg1: Project = {
      id: 'project-1',
      organizationId: 'org-1',
      name: 'Fall 2026',
      archivedAt: null,
      createdAt: 0,
    }
    listProjects.mockResolvedValue([projectOrg1])
    listCourses.mockResolvedValue([])
    const onSignedOut = vi.fn()

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut })
    await screen.findByText('Fall 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Fall 2026' }))
    await screen.findByRole('button', { name: 'New course' })
    fireEvent.click(screen.getByRole('button', { name: 'New course' }))
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'A course I never saved' },
    })

    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Discard unsaved changes?',
    })
    // Blocked until confirmed — signOut has not run yet.
    expect(signOut).not.toHaveBeenCalled()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Discard changes' })
    )
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1))
  })

  it('switching organizations resets the projects panel rather than stranding it on a refusal from the previous organization (finding 5)', async () => {
    const projectOrg1: Project = {
      id: 'project-1',
      organizationId: 'org-1',
      name: 'Fall 2026',
      archivedAt: null,
      createdAt: 0,
    }
    listProjects.mockImplementation((organizationId: string) =>
      Promise.resolve(organizationId === 'org-1' ? [projectOrg1] : [])
    )
    // `courses.list` refuses — the same shape a cross-tenant project id gets
    // (TEN-2/TEN-5) — standing in for what happens if a project selected in
    // org-1 were still selected once org-2 became active.
    listCourses.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })

    await screen.findByText('Fall 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Fall 2026' }))
    await screen.findByRole('alert')

    // Switch organizations. Without `key={activeOrganizationId}` on
    // `ProjectsPanel` (`pages/Shell.tsx`), this refusal — and the project it
    // belonged to — would still be showing, unclearable short of a reload.
    switchOrganization('Org Two')

    await waitFor(() =>
      expect(listProjects).toHaveBeenCalledWith('org-2', false)
    )
    // Back on the projects list for the newly active organization, not
    // stuck on the previous organization's stranded refusal.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Projects' })
    ).toBeInTheDocument()
  })

  // ADMIN-1..3: a fourth tab, the same shape Discord/Projects/Chat already
  // take — switching to it renders `pages/Transcripts.tsx`, not the
  // Projects panel it defaulted to on mount.
  it('switches to the Transcripts tab', async () => {
    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Transcripts' }))

    expect(
      await screen.findByRole('heading', { name: 'Transcripts' })
    ).toBeInTheDocument()
  })

  // COST-3/COST-4: a fifth tab, the same shape Discord/Projects/Chat/
  // Transcripts already take — switching to it renders `pages/Usage.tsx`,
  // and the caller's own owner role in org-1 (`MULTI_MEMBERSHIP_ACCOUNT`)
  // reaches it as `isOwner`, so the cap-setting form renders too.
  it("switches to the Usage tab, and passes the caller's own owner role through as isOwner", async () => {
    fetchOrganizationUsage.mockResolvedValue({
      organizationId: 'org-1',
      spendingCapMicros: null,
      totalCostMicros: 0,
      totalEstimatedCostMicros: 0,
      courses: [],
      studentsNearLimit: [],
      bySurface: [],
    })

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    openDrawer()
    fireEvent.click(
      screen.getByRole('button', { name: 'Organization settings' })
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Usage' }))

    expect(
      await screen.findByRole('heading', { name: 'Usage' })
    ).toBeInTheDocument()
    expect(fetchOrganizationUsage).toHaveBeenCalledWith(
      'org-1',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    )
    // org-1's own membership is 'owner' — the cap-setting form is offered.
    expect(await screen.findByLabelText('Spending cap ($)')).toBeInTheDocument()
  })

  // The second membership in `MULTI_MEMBERSHIP_ACCOUNT` is 'assistant', not
  // 'owner' — the same tab renders, but withholds the form
  // (`pages/Usage.tsx`'s own module comment on why).
  it('the Usage tab withholds the cap-setting form for a non-owner membership', async () => {
    fetchOrganizationUsage.mockResolvedValue({
      organizationId: 'org-2',
      spendingCapMicros: null,
      totalCostMicros: 0,
      totalEstimatedCostMicros: 0,
      courses: [],
      studentsNearLimit: [],
      bySurface: [],
    })

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    switchOrganization('Org Two')
    openDrawer()
    fireEvent.click(
      screen.getByRole('button', { name: 'Organization settings' })
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Usage' }))

    await screen.findByRole('heading', { name: 'Usage' })
    expect(screen.queryByLabelText('Spending cap ($)')).not.toBeInTheDocument()
  })

  // ENRL-5: a sixth tab, the same shape Usage above already takes —
  // switching to it renders `components/Team.tsx`, and the caller's own
  // owner role in org-1 (`MULTI_MEMBERSHIP_ACCOUNT`) reaches it as
  // `isOwner`, so the grant form renders too.
  it("switches to the Team tab, and passes the caller's own owner role through as isOwner", async () => {
    listMemberships.mockResolvedValue([])

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    openDrawer()
    fireEvent.click(
      screen.getByRole('button', { name: 'Organization settings' })
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Team' }))

    expect(
      await screen.findByRole('heading', { name: 'Team' })
    ).toBeInTheDocument()
    expect(listMemberships).toHaveBeenCalledWith('org-1')
    // org-1's own membership is 'owner' — the grant form is offered.
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
  })

  // The second membership in `MULTI_MEMBERSHIP_ACCOUNT` is 'assistant', not
  // 'owner' — the same tab renders, but withholds the form
  // (`components/Team.tsx`'s own module comment on why).
  it('the Team tab withholds the grant form for a non-owner membership', async () => {
    listMemberships.mockResolvedValue([])

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    switchOrganization('Org Two')
    openDrawer()
    fireEvent.click(
      screen.getByRole('button', { name: 'Organization settings' })
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Team' }))

    await screen.findByRole('heading', { name: 'Team' })
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  // JOB-2: a seventh tab, the same shape Usage/Team above already take —
  // switching to it renders `pages/Jobs.tsx` and fetches the caller's own
  // organization's jobs. No `isOwner`: `jobs.list` carries no owner-only
  // restriction (`pages/Shell.tsx`'s own module comment on why).
  it('switches to the Jobs tab, and lists the active organization’s own jobs', async () => {
    listJobs.mockResolvedValue([])

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    openDrawer()
    fireEvent.click(
      screen.getByRole('button', { name: 'Organization settings' })
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Jobs' }))

    expect(
      await screen.findByRole('heading', { name: 'Jobs' })
    ).toBeInTheDocument()
    expect(listJobs).toHaveBeenCalledWith('org-1')
  })

  // --- LINK-10: a connected-but-not-a-member organization -------------------
  //
  // A membership (TEN-1's administrative relationship) is not the same
  // thing as a connected person (LINK-3's proof) — `routes/actions.ts`
  // refuses every dispatched action (Discord, Projects, Transcripts) for a
  // caller with no membership, unconditionally, so none of those tabs are
  // offered at all once this organization is active. `routes/chat.ts`
  // authorizes on an active enrolment instead, never a membership, so Chat
  // stays reachable.
  describe('a connected-but-not-a-member organization (LINK-10)', () => {
    it('mounts on the account`s own membership organization by default, offering every tab', () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      expect(screen.getByTestId('organization-switcher')).toHaveTextContent(
        'Student'
      )
      openDrawer()
      expect(
        screen.getByRole('button', { name: 'Organization settings' })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Transcripts' })
      ).toBeInTheDocument()
    })

    // WEB-47 rename — Chat is no longer the only tab this account keeps
    // here: MCP is offered too (the same audience, `Shell.tsx`'s own
    // module comment on why). The absences below are what this test
    // actually proves; only the title used to overclaim.
    it('switching to the connected-only organization drops Discord/Projects/Transcripts, and Chat is what actually renders', async () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })

      switchOrganization('A University')

      // Discord, Projects and Transcripts are gone — not merely disabled —
      // once this organization is active. The drawer is opened first so
      // this actually proves absence, not merely that a closed drawer has
      // nothing to show.
      openDrawer()
      expect(
        screen.queryByRole('button', { name: 'Organization settings' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Projects' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Transcripts' })
      ).not.toBeInTheDocument()
      // Chat renders — the screen this account can actually reach here
      // (`routes/chat.ts`'s own enrolment-based authorization).
      await waitFor(() =>
        expect(listChatCourses).toHaveBeenCalledWith('institution-org')
      )
      expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument()
    })

    it('a tab selected before the switch (Discord) does not leak into the connected-only organization', async () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      // Select the settings screen's own Discord tab while still on the
      // membership organization...
      openDrawer()
      fireEvent.click(
        screen.getByRole('button', { name: 'Organization settings' })
      )
      fireEvent.click(screen.getByRole('tab', { name: 'Discord' }))
      expect(
        screen.getByRole('heading', { name: 'Discord' })
      ).toBeInTheDocument()

      // ...then switch. Without `effectiveTab` overriding a stale
      // `activeTab`, this would still try to render `InstallButton` here —
      // a control this account's every click against would refuse.
      switchOrganization('A University')

      expect(
        screen.queryByRole('heading', { name: 'Discord' })
      ).not.toBeInTheDocument()
      expect(
        await screen.findByRole('heading', { name: 'Chat' })
      ).toBeInTheDocument()
    })

    it('the home control returns to Chat, not Projects, while a connected-only organization is active', async () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      switchOrganization('A University')
      await screen.findByRole('heading', { name: 'Chat' })

      fireEvent.click(screen.getByRole('button', { name: 'Home' }))

      // Still Chat — 'projects' (this shell's own ordinary home) is not a
      // screen this account can reach here. Drawer opened first, the same
      // "actually prove absence" reasoning the switch test above uses.
      openDrawer()
      expect(
        screen.queryByRole('button', { name: 'Projects' })
      ).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument()
    })

    it('the switcher offers the connected organization labelled "connected", never a membership role it does not have', () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      // WEB-56 — the switcher is a real menu now, not a `<select>`: its
      // options only render once opened.
      fireEvent.click(
        within(screen.getByTestId('organization-switcher')).getByRole('button')
      )
      expect(
        screen.getByRole('button', { name: 'A University (connected)' })
      ).toBeInTheDocument()
    })
  })

  // --- WEB-47: the MCP tab, beside Chat for every account, member or not --
  describe('the MCP tab (WEB-47)', () => {
    it('renders for a member', () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'MCP' }))
      expect(screen.getByRole('heading', { name: 'MCP' })).toBeInTheDocument()
    })

    // LINK-10 — the same audience Chat already reaches: a connected-only
    // account, switched to the organization it holds no membership in,
    // still sees and can open this tab.
    it('renders for a connected non-member', () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      switchOrganization('A University')
      openDrawer()
      expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'MCP' }))
      expect(screen.getByRole('heading', { name: 'MCP' })).toBeInTheDocument()
    })

    // WEB-32/WEB-34 — reachable and selected from the address, both
    // directions, the same discipline every other tab already holds
    // itself to (`tests/routing.test.ts` proves the parser/builder side;
    // this proves `tabForRoute` picks it out here).
    it('is selected from the address', () => {
      renderShell({
        account: MULTI_MEMBERSHIP_ACCOUNT,
        route: { kind: 'mcp', organizationId: 'org-1' },
        onSignedOut: vi.fn(),
      })
      expect(screen.getByRole('heading', { name: 'MCP' })).toBeInTheDocument()
    })
  })

  // --- WEB-29/WEB-30: the drawer's own divider, sign-out, the header's
  // organization name, and the profile control reaching account settings ---
  describe('the navigation drawer and account settings (WEB-29, WEB-30)', () => {
    it('divides the drawer into two groups with a visible separator, for a member', () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      const nav = screen.getByRole('navigation', { name: 'Main' })
      const separator = screen.getByRole('separator')
      expect(nav).toContainElement(separator)
      // The everyday group (Projects, Chat, Transcripts) precedes the
      // separator; the organization group (WEB-69's own one "Organization
      // settings" entry, in place of the four this drawer used to carry)
      // follows it.
      const projects = screen.getByRole('button', { name: 'Projects' })
      const settings = screen.getByRole('button', {
        name: 'Organization settings',
      })
      expect(
        projects.compareDocumentPosition(separator) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(
        separator.compareDocumentPosition(settings) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('offers no separator, and no organization group, for a connected-but-not-a-member account', () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      // The account's own membership organization (`personal-org`) is the
      // initial active one, and offers every tab — the connected-only
      // organization (LINK-10) is what has no organization group at all.
      switchOrganization('A University')
      openDrawer()
      expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    })

    // WEB-56 — a second copy of the organization control, above the
    // drawer's own links, so which organization they act in is never
    // ambiguous while the drawer is open.
    it('shows the organization control above the drawer’s own links, and switches from there', async () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()

      const drawerSwitcher = screen.getByTestId('organization-switcher-drawer')
      expect(drawerSwitcher).toHaveTextContent('Org One')
      const nav = screen.getByRole('navigation', { name: 'Main' })
      const projects = screen.getByRole('button', { name: 'Projects' })
      expect(
        drawerSwitcher.compareDocumentPosition(nav) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(nav).toContainElement(projects)

      fireEvent.click(
        within(drawerSwitcher).getByRole('button', { name: /Org One/ })
      )
      fireEvent.click(screen.getByRole('button', { name: /Org Two/ }))

      // Switching from the drawer's own copy also closes the drawer, the
      // same discipline every other drawer control already follows
      // (`components/SignedInChrome.tsx`'s own module comment on why) —
      // `AppShell.tsx`'s own closing transition is pinned in
      // `tests/app-shell.test.tsx`, so this only checks that closing was
      // actually requested (the drawer's own translated-away position),
      // not the transition itself.
      expect(screen.getByRole('dialog', { name: 'Navigation' })).toHaveClass(
        '-translate-x-full'
      )
      await waitFor(() =>
        expect(screen.getByTestId('organization-switcher')).toHaveTextContent(
          'Org Two'
        )
      )
    })

    it('carries sign-out at the drawer’s foot, reachable once the drawer is open', () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      // Not reachable before the drawer opens — it lives in the drawer now,
      // not the header (this file's own `openDrawer` helper on why every
      // other nav click in this file needs it too).
      expect(
        screen.queryByRole('button', { name: 'Sign out' })
      ).not.toBeInTheDocument()
      openDrawer()
      expect(
        screen.getByRole('button', { name: 'Sign out' })
      ).toBeInTheDocument()
    })

    // WEB-59: an Admin link, in its own section below the existing groups,
    // divided the way the organization group already is (this describe
    // block's own first test on that divider) — shown only for an account
    // `GET /auth/me` actually reports as a platform administrator.
    describe('the Admin link (WEB-59)', () => {
      it('offers no Admin link for an ordinary account, even one with two memberships', () => {
        renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
        openDrawer()

        expect(
          screen.queryByRole('button', { name: 'Admin' })
        ).not.toBeInTheDocument()
      })

      it('offers an Admin link, in its own section below the existing groups, for a platform administrator, and it navigates to the console', () => {
        const adminAccount: AccountSummary = {
          ...MULTI_MEMBERSHIP_ACCOUNT,
          isPlatformAdministrator: true,
        }
        const onNavigate = vi.fn()
        renderShell({
          account: adminAccount,
          onSignedOut: vi.fn(),
          onNavigate,
        })
        openDrawer()

        const nav = screen.getByRole('navigation', { name: 'Main' })
        const adminLink = screen.getByRole('button', { name: 'Admin' })
        expect(nav).toContainElement(adminLink)
        // Below every other group — the organization group's own one item
        // (WEB-69's "Organization settings") precedes it, the same "later
        // in the DOM" relation this describe block's own first test already
        // uses for the divider.
        const settings = screen.getByRole('button', {
          name: 'Organization settings',
        })
        expect(
          settings.compareDocumentPosition(adminLink) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        // Its own divider, distinct from the one between the everyday and
        // organization groups.
        expect(screen.getAllByRole('separator')).toHaveLength(2)

        fireEvent.click(adminLink)
        expect(onNavigate).toHaveBeenCalledWith({ kind: 'platform-admin' })
        // Closes the drawer the same way every other drawer control does —
        // `tests/app-shell.test.tsx` pins the transition itself; this only
        // checks that closing was actually requested (the switcher test
        // above, in this same describe block, checks the same thing the
        // same way).
        expect(screen.getByRole('dialog', { name: 'Navigation' })).toHaveClass(
          '-translate-x-full'
        )
      })
    })

    it("states the acting organization's name at the header's leading edge, beside the home control — not the trailing edge with the profile control", () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      // A single option would read plainly; two memberships (this account)
      // read as a dropdown whose own current value is the active
      // organization's name — `Org One` (org-1), the initial active
      // organization.
      const switcher = screen.getByTestId('organization-switcher')
      expect(switcher).toHaveTextContent('Org One')

      // Coordinator review finding: the assertion above alone holds
      // whether the switcher renders in `headerStart` (WEB-30's own
      // "immediately right of the home control") or `headerEnd` (where
      // sign-out used to sit, pre-WEB-30) — it only reads the switcher's
      // own text, never where in the header it actually sits, so it does
      // not distinguish the two. Pinned here: the switcher must share the
      // header's *leading* group — the one the Home control renders
      // into — not the trailing group where the profile control lives.
      const header = screen.getByRole('banner')
      const homeButton = within(header).getByRole('button', { name: 'Home' })
      const leadingGroup = homeButton.closest('div')
      expect(leadingGroup).not.toBeNull()
      expect(leadingGroup).toContainElement(switcher)
      // And, the negative that actually rules the regression out: the
      // profile control's own group does not also contain it.
      const profileButton = within(header).getByRole('button', {
        name: 'Account settings',
      })
      expect(profileButton.closest('div')).not.toContainElement(switcher)
    })

    it('the profile control opens account settings, listing every organization and the active one', async () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      fireEvent.click(screen.getByRole('button', { name: 'Account settings' }))
      expect(
        await screen.findByRole('heading', { name: 'Account' })
      ).toBeInTheDocument()
      // Scoped to the account page itself — `Org One` is also the header's
      // own switcher option, still on screen underneath.
      const accountPage = within(screen.getByTestId('account-page'))
      expect(
        accountPage.getByText('instructor@example.edu')
      ).toBeInTheDocument()
      expect(accountPage.getByText(/Org One/).closest('li')).toHaveTextContent(
        'Active'
      )
    })

    it('a connected-but-not-a-member account can still reach account settings, and switch from there to an organization where it is a member', async () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      // Switch to the connected-only organization first — the account's own
      // membership organization (`personal-org`) is otherwise already
      // active by default, which would not actually exercise the
      // non-member case this test names.
      switchOrganization('A University')
      await screen.findByRole('heading', { name: 'Chat' })

      fireEvent.click(screen.getByRole('button', { name: 'Account settings' }))
      expect(
        await screen.findByRole('heading', { name: 'Account' })
      ).toBeInTheDocument()

      // Scoped to the account page itself — `Student` (the account's own
      // personal organization's name) is also the header's own switcher
      // option, still on screen underneath.
      const membershipRow = within(screen.getByTestId('account-page'))
        .getByText(/Student/)
        .closest('li')
      fireEvent.click(
        membershipRow!.querySelector('button') as HTMLButtonElement
      )

      // Switched — and, being a member there, the ordinary tab set is
      // offered again (`effectiveTab`'s own `'account'` carve-out, this
      // file's own module comment).
      expect(
        await screen.findByTestId('organization-switcher')
      ).toHaveTextContent('Student')
    })

    // --- WEB-41: the header's organization name is a real link ------------

    it('the header’s single-organization name is a link to that organization’s main page', () => {
      renderShell({ account: SINGLE_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      const header = screen.getByRole('banner')
      expect(
        within(header).getByRole('link', { name: 'Org One' })
      ).toHaveAttribute('href', '/o/org-1/projects')
    })

    // WEB-41's own carve-out: `/account` deliberately names no
    // organization (WEB-30's `'account'` route), but the header still
    // shows one — `Shell.tsx`'s own `rememberedOrganizationId`, the
    // organization that was active immediately before `/account` was
    // opened. Decision for this slice: the header's link stays correct
    // for that remembered organization rather than disappearing —
    // opening it does not disturb `/account` itself (the same "does not
    // change which organization is active" `Account.tsx`'s own rows
    // already hold to), and it is a real destination, not a guess.
    it('on /account, the header’s organization link still points at the organization that was active beforehand', () => {
      renderShell({
        account: SINGLE_MEMBERSHIP_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      fireEvent.click(screen.getByRole('button', { name: 'Account settings' }))
      const header = screen.getByRole('banner')
      expect(
        within(header).getByRole('link', { name: 'Org One' })
      ).toHaveAttribute('href', '/o/org-1/projects')
    })

    // Code review (round 2), must-fix 3 — `rememberedOrganizationId` used to
    // be set only from `route` (never corrected against `account` itself),
    // so leaving the remembered organization while `/account` was open
    // (WEB-58, `pages/Account.tsx`'s own `OrganizationList`) left it naming
    // an organization this account no longer belonged to:
    // `navigate({ kind: 'account' })` — `OrganizationList.tsx`'s own
    // fallback when nothing else is left to switch to — is a no-op here,
    // since `route.kind` is already `'account'`. `OrganizationSwitcher.tsx`
    // then found no option matching the stale id and fell back to rendering
    // the raw id — precisely the leak `components/SignedInChrome.tsx`'s own
    // module comment says must never happen. Exercised directly, by
    // rerendering with a fresh `account` prop that no longer includes the
    // remembered organization — the same shape a `refreshAccount()` after a
    // Leave produces (`App.tsx#refreshAccount`), without needing a real
    // Leave dispatch to reach it.
    it('on /account, a refreshed account that no longer includes the remembered organization corrects the header rather than showing its raw id', async () => {
      const beforeLeaving: AccountSummary = {
        id: 'account-9',
        email: 'member@example.edu',
        isPlatformAdministrator: false,
        memberships: [
          {
            organizationId: 'org-team',
            organizationName: 'Team Org',
            role: 'assistant',
          },
          {
            organizationId: 'org-personal',
            organizationName: 'Personal Org',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      }
      const afterLeaving: AccountSummary = {
        ...beforeLeaving,
        memberships: beforeLeaving.memberships.filter(
          (membership) => membership.organizationId !== 'org-team'
        ),
      }
      const { rerender } = renderWithModal(
        <Shell
          account={beforeLeaving}
          route={{ kind: 'account' }}
          navigate={vi.fn()}
          onSignedOut={vi.fn()}
        />
      )
      // Mounting directly on `/account` remembers the first membership
      // listed (`rememberedOrganizationId`'s own initializer) — `org-team`.
      expect(screen.getByTestId('organization-switcher')).toHaveTextContent(
        'Team Org'
      )

      rerender(
        withModal(
          <Shell
            account={afterLeaving}
            route={{ kind: 'account' }}
            navigate={vi.fn()}
            onSignedOut={vi.fn()}
          />
        )
      )

      await waitFor(() =>
        expect(screen.getByTestId('organization-switcher')).toHaveTextContent(
          'Personal Org'
        )
      )
      expect(screen.getByTestId('organization-switcher')).not.toHaveTextContent(
        'org-team'
      )
    })

    // WEB-41 rework (must-fix 1, coordinator review) — the header's own
    // link is a navigation this shell starts, exactly like the drawer's
    // items, the home control and the multi-org `<select>`
    // (`changeActiveOrganization`) — all of which already go through
    // `guardedNavigate` (WEB-16). Before this fix, `Shell.tsx` passed the
    // raw `navigate` straight to `OrganizationSwitcher`, so this one path
    // bypassed the guard and discarded a dirty form's edits with no
    // prompt at all — the same class of gap the Sign-out rework above
    // this `describe` block already closed for a different control.
    it('a dirty course form asks first, even though the click that would discard it is the header’s organization link', async () => {
      const projectOrg1: Project = {
        id: 'project-1',
        organizationId: 'org-1',
        name: 'Fall 2026',
        archivedAt: null,
        createdAt: 0,
      }
      listProjects.mockResolvedValue([projectOrg1])
      listCourses.mockResolvedValue([])

      renderShell({ account: SINGLE_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      await screen.findByText('Fall 2026')
      fireEvent.click(screen.getByRole('button', { name: 'Fall 2026' }))
      await screen.findByRole('button', { name: 'New course' })
      fireEvent.click(screen.getByRole('button', { name: 'New course' }))
      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: 'A course I never saved' },
      })

      const header = screen.getByRole('banner')
      fireEvent.click(within(header).getByRole('link', { name: 'Org One' }))

      // Blocked until confirmed — still on the dirty form, title intact.
      const dialog = await screen.findByRole('dialog', {
        name: 'Discard unsaved changes?',
      })
      expect(screen.getByLabelText('Title')).toHaveValue(
        'A course I never saved'
      )

      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Discard changes' })
      )
      // Confirmed — now it actually navigates, to the address the link
      // named all along.
      await screen.findByRole('heading', { name: 'Projects' })
    })
  })

  // WEB-28: a course row's own Chat button switches the shell to its Chat
  // tab with that exact course already selected — end to end, at the shell
  // level, since `pages/Courses.tsx`'s own test only proves the id reaches
  // `onOpenChat`, not that the handoff `pages/Shell.tsx` owns actually lands
  // on the right screen.
  describe("a course row's Chat button (WEB-28)", () => {
    const COURSE: CourseSummary = {
      id: 'course-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      title: 'Web Design',
      enabled: true,
      adminsRole: 'admins-wd-fa26',
      studentsRole: 'students-wd-fa26',
      promptId: null,
      instructions: null,
      model: null,
      vectorStoreId: null,
      maxRequestsPerDay: null,
      conversationScope: 'course',
      selfEnrolFromDiscord: false,
      answerUnenrolled: true,
      discordServerId: null,
      createdAt: 0,
      aiApprovedAt: 1000,
    }

    const SECOND_COURSE: CourseSummary = {
      ...COURSE,
      id: 'course-2',
      title: 'Data Structures',
      adminsRole: 'admins-ds-fa26',
      studentsRole: 'students-ds-fa26',
    }

    beforeEach(() => {
      listProjects.mockResolvedValue([
        {
          id: 'project-1',
          organizationId: 'org-1',
          name: 'Fall 2026',
          archivedAt: null,
          createdAt: 0,
        },
      ])
      // Two courses — `Chat.tsx` only renders its own `<select>` (rather
      // than a single course's plain-text heading) once there is more than
      // one to choose among, and this file's own assertions below need the
      // `<select>`'s value to actually pin *which* course landed selected.
      listCourses.mockResolvedValue([COURSE, SECOND_COURSE])
      listChatCourses.mockImplementation((organizationId: string) =>
        Promise.resolve(
          organizationId === 'org-1'
            ? [
                { id: 'course-1', title: 'Web Design' },
                { id: 'course-2', title: 'Data Structures' },
              ]
            : []
        )
      )
    })

    it('clicking Chat on a course row lands on the Chat tab with that course already selected', async () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      // Defaults to the Projects tab (`Shell.tsx`'s own default) — navigate
      // into the project, then its course list.
      fireEvent.click(await screen.findByRole('button', { name: 'Fall 2026' }))
      await screen.findByText('Data Structures')
      // Named by its own row (`Courses.tsx`'s own `aria-label`, WEB-28
      // rework) — not a positional index into every "Chat" button on the
      // screen, which is exactly what a row-naming label exists to make
      // unnecessary.
      fireEvent.click(
        screen.getByRole('button', { name: 'Chat about "Web Design"' })
      )

      // Landed on the Chat tab — not merely that some "Chat" text exists
      // (the drawer's own nav item also reads "Chat"), but the screen's own
      // heading, and this exact course selected in its own picker.
      expect(
        await screen.findByRole('heading', { name: 'Chat' })
      ).toBeInTheDocument()
      expect(
        await screen.findByRole('combobox', { name: 'Course' })
      ).toHaveValue('course-1')
    })

    it('a second Chat click, for the same organization, still lands on the newly requested course', async () => {
      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      fireEvent.click(await screen.findByRole('button', { name: 'Fall 2026' }))
      await screen.findByText('Data Structures')
      fireEvent.click(
        screen.getByRole('button', { name: 'Chat about "Web Design"' })
      )
      expect(
        await screen.findByRole('combobox', { name: 'Course' })
      ).toHaveValue('course-1')

      // Back to Projects, then Chat again for the *other* course — `Chat`
      // unmounts entirely on the way there (it lives in a ternary chain
      // with `ProjectsPanel`, `Shell.tsx`'s own render), so this proves the
      // route's own `courseId` (WEB-32, not shell state) is what a fresh
      // mount actually reads.
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Fall 2026' }))
      await screen.findByText('Data Structures')
      fireEvent.click(
        screen.getByRole('button', { name: 'Chat about "Data Structures"' })
      )

      expect(
        await screen.findByRole('combobox', { name: 'Course' })
      ).toHaveValue('course-2')
    })

    // Must-fix 1 (round 1 rework): before WEB-32, a course a previous Chat
    // click requested was held in shell state (`chatCourseId`) that used to
    // survive an organization switch untouched, seeding a freshly mounted
    // `Chat`'s `selectedCourseId` with a course id belonging to the
    // *previous* organization. WEB-32/WEB-34 structurally rules that class
    // of bug out rather than guarding against it by hand: `routeForTab`
    // (`routing/route.ts`), the one function `pages/Shell.tsx#changeActiveOrganization`
    // ever builds a route through, never carries a course id across an
    // organization switch at all — there is no stale value left to seed
    // `Chat` with. Kept as a regression test anyway (the same "defended, not
    // assumed" discipline this codebase already holds itself to): this
    // asserts on what actually drives a sent question — `getChatMessages`'s
    // own call — rather than the `<select>`'s displayed value, which looked
    // identical whether the original bug was present or fixed.
    it('switching organizations clears a course a previous Chat click requested — it must not survive into a different organization', async () => {
      listChatCourses.mockImplementation((organizationId: string) =>
        Promise.resolve(
          organizationId === 'org-1'
            ? [
                { id: 'course-1', title: 'Web Design' },
                { id: 'course-2', title: 'Data Structures' },
              ]
            : organizationId === 'org-2'
              ? [
                  { id: 'course-9', title: 'Org Two Course A' },
                  { id: 'course-10', title: 'Org Two Course B' },
                ]
              : []
        )
      )

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      fireEvent.click(await screen.findByRole('button', { name: 'Fall 2026' }))
      await screen.findByText('Data Structures')
      fireEvent.click(
        screen.getByRole('button', { name: 'Chat about "Web Design"' })
      )
      await waitFor(() =>
        expect(getChatMessages).toHaveBeenCalledWith('org-1', 'course-1')
      )

      // Switch to Org Two — `course-1` belongs to Org One and must not
      // survive the switch.
      switchOrganization('Org Two')

      await waitFor(() =>
        expect(getChatMessages).toHaveBeenCalledWith('org-2', 'course-9')
      )
      // The stale id is never dispatched under the new organization —
      // fails without the fix, which calls `getChatMessages('org-2',
      // 'course-1')` instead (a course Org Two's `listChatCourses` never
      // even returned).
      expect(getChatMessages).not.toHaveBeenCalledWith('org-2', 'course-1')
    })
  })
})
