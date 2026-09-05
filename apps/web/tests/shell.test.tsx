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
  DiscordServerBindingSummary,
  Project,
} from '../src/api/types.js'
import { Shell, type ShellProps } from '../src/pages/Shell.js'
import {
  isShellRoute,
  type Route,
  type ShellRoute,
} from '../src/routing/route.js'
import { renderWithModal } from './helpers/render-with-modal.js'

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
  props: Omit<ShellProps, 'route' | 'navigate'> & { route?: ShellRoute }
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

const MULTI_MEMBERSHIP_ACCOUNT: AccountSummary = {
  id: 'account-1',
  email: 'instructor@example.edu',
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
  getChatMessages.mockResolvedValue([])
})

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('Shell (WEB-3, WEB-4)', () => {
  // WEB-32/WEB-34 rework — "which organization a *fresh mount* opens on"
  // (an install that just completed for a different organization than the
  // first membership, a defensively-ignored `justInstalled`/`joinedCourse`
  // naming an organization this account cannot reach, a redeemed join link
  // opening directly on Chat) is `App.tsx`'s own `resolveHomeRoute` now, not
  // anything `Shell` decides — those cases moved to `tests/app.test.tsx`'s
  // own "App — / home resolution" describe block, which drives the real
  // round trip (a Discord callback, a redeemed join link) rather than a
  // prop this component no longer reads for that purpose. `justInstalled`
  // remains a real `Shell` prop (the Discord tab's own *immediate* install
  // signal, TEN-8 below) — only the organization-selection use of it moved.

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
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

    // Switch away from the organization this mounted with...
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })
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
      route: { kind: 'discord', organizationId: 'org-2' },
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })

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
    })

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))

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
    })

    renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Team' }))

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
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })
    openDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Team' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }))

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
      expect(
        screen.getByRole('combobox', { name: 'Organization' })
      ).toHaveValue('personal-org')
      openDrawer()
      expect(
        screen.getByRole('button', { name: 'Discord' })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Transcripts' })
      ).toBeInTheDocument()
    })

    it('switching to the connected-only organization offers only Chat, and Chat is what actually renders', async () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })

      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })

      // Discord, Projects and Transcripts are gone — not merely disabled —
      // once this organization is active. The drawer is opened first so
      // this actually proves absence, not merely that a closed drawer has
      // nothing to show.
      openDrawer()
      expect(
        screen.queryByRole('button', { name: 'Discord' })
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
      // Select Discord while still on the membership organization...
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
      expect(
        screen.getByRole('heading', { name: 'Discord' })
      ).toBeInTheDocument()

      // ...then switch. Without `effectiveTab` overriding a stale
      // `activeTab`, this would still try to render `InstallButton` here —
      // a control this account's every click against would refuse.
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })

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
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })
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
      const select = screen.getByRole('combobox', { name: 'Organization' })
      expect(select).toHaveTextContent('A University (connected)')
    })
  })

  // --- TEN-8: the panel reads the organization's actual Discord binding ---
  //
  // Before this slice, `installedServerId` came from `justInstalled` alone
  // — set only once, by `App.tsx`, when a Discord OAuth callback completes
  // in *this* browser session. A reload, a second device, or an install
  // from an earlier session all left `justInstalled` `undefined`, so the
  // Discord tab offered "Install" for a server that was already bound, and
  // `handleRemove`'s `if (!installedServerId) return` made Remove
  // unreachable for exactly the accounts who most need it. Every test
  // below renders with no `justInstalled` prop at all — the reload/second-
  // device shape this gap actually broke.
  describe("reading the organization's actual Discord binding (TEN-8)", () => {
    const EXISTING_BINDING: DiscordServerBindingSummary = {
      serverId: 'guild-99',
      organizationId: 'org-1',
      // A different account than the one signed in below — standing in for
      // an install from an earlier session, or a colleague's device, which
      // is exactly what `justInstalled` (this browser's own one-time
      // signal) cannot know about.
      installedByAccountId: 'account-other',
      installedAt: Date.now() - 86_400_000,
      removedAt: null,
    }

    it('a reload with an existing binding shows it as installed, with Remove offered — this is the defect', async () => {
      dispatchAction.mockResolvedValue({ result: undefined })
      listDiscordServers.mockResolvedValue([EXISTING_BINDING])

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

      // A fetched binding this session never created still renders as
      // installed. TEN-9 — "Install to Discord" is offered too, now,
      // alongside an existing binding: an organization can bind more than
      // one server, so this is "install another," not a state this screen
      // used to treat as mutually exclusive with "already installed."
      expect(await screen.findByText(/guild-99/)).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Install to Discord' })
      ).toBeInTheDocument()

      // Remove is reachable for a binding this session did not create —
      // `handleRemove`'s own `if (!installedServerId) return` used to make
      // this unreachable whenever `justInstalled` was `undefined`.
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() =>
        expect(dispatchAction).toHaveBeenCalledWith(
          'org-1',
          'discordServers.remove',
          { serverId: 'guild-99' }
        )
      )
      expect(
        await screen.findByRole('button', { name: 'Install to Discord' })
      ).toBeInTheDocument()
    })

    it('a lookup in flight does not render "Install"', async () => {
      // An unresolved promise — `listDiscordServers` never settles for the
      // life of this test — standing in for the round trip genuinely being
      // in flight.
      let settle:
        ((bindings: DiscordServerBindingSummary[]) => void) | undefined
      listDiscordServers.mockImplementation(
        () =>
          new Promise((resolve) => {
            settle = resolve
          })
      )

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

      // An owner seeing "Install" for a server that is already bound is the
      // exact bug this fetch exists to fix — a momentary version of it,
      // while the lookup is still in flight, is still it.
      expect(
        screen.queryByRole('button', { name: 'Install to Discord' })
      ).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent('Loading…')

      // Let the promise settle before this test ends, so cleanup does not
      // unmount a component with a still-pending state update.
      settle?.([])
      await screen.findByRole('button', { name: 'Install to Discord' })
    })

    it('a failed lookup reports the failure rather than rendering "not installed"', async () => {
      listDiscordServers.mockRejectedValue(
        new ApiError(500, { error: 'internal_error' })
      )

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

      // Rendering "Install" here would be the exact same bug this slice
      // fixes, reached by a different path (a failed round trip standing
      // in for a stale one) — so a failure must say so, through the same
      // `ErrorMessage` path every other refusal in this app already uses,
      // not fall back to "not installed."
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong. Try again.'
      )
      expect(
        screen.queryByRole('button', { name: 'Install to Discord' })
      ).not.toBeInTheDocument()
    })
  })

  // --- TEN-9: an organization can bind more than one Discord server -------
  describe('multiple active Discord server bindings (TEN-9)', () => {
    const BINDING_A: DiscordServerBindingSummary = {
      serverId: 'guild-a',
      organizationId: 'org-1',
      installedByAccountId: 'account-other',
      installedAt: Date.now() - 86_400_000,
      removedAt: null,
    }
    const BINDING_B: DiscordServerBindingSummary = {
      serverId: 'guild-b',
      organizationId: 'org-1',
      installedByAccountId: 'account-other',
      installedAt: Date.now() - 43_200_000,
      removedAt: null,
    }

    it('lists every active binding with its own Remove, and still offers installing another', async () => {
      listDiscordServers.mockResolvedValue([BINDING_A, BINDING_B])

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

      expect(await screen.findByText(/guild-a/)).toBeInTheDocument()
      expect(screen.getByText(/guild-b/)).toBeInTheDocument()
      // One "Install to Discord" pair per binding — never one Install/Remove
      // pair for the whole organization the way this screen used to be.
      expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
      expect(
        screen.getByRole('button', { name: 'Install to Discord' })
      ).toBeInTheDocument()
    })

    it('removing one binding leaves the other listed, still active', async () => {
      dispatchAction.mockResolvedValue({ result: undefined })
      listDiscordServers.mockResolvedValue([BINDING_A, BINDING_B])

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
      await screen.findByText(/guild-a/)

      // Two rows, each with its own Remove — click the first one's.
      const [firstRemove] = screen.getAllByRole('button', { name: 'Remove' })
      if (!firstRemove) throw new Error('expected a Remove button')
      fireEvent.click(firstRemove)
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() =>
        expect(dispatchAction).toHaveBeenCalledWith(
          'org-1',
          'discordServers.remove',
          { serverId: 'guild-a' }
        )
      )
      // `guild-a`'s own row is gone; `guild-b` is untouched and still
      // offers its own Remove — the identity of which binding was removed,
      // not merely that a removal happened.
      await waitFor(() =>
        expect(screen.queryByText(/guild-a/)).not.toBeInTheDocument()
      )
      expect(screen.getByText(/guild-b/)).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
    })
  })

  // --- TEN-8 rework — coordinator review findings -------------------------
  //
  // Two must-fix regressions the first pass introduced, plus three surviving
  // mutants the coordinator's own probe found: behaviour that happened to be
  // correct with nothing in this file pinning it there.
  describe('TEN-8 rework: coordinator review findings', () => {
    it('must-fix 1: does not resurrect a binding this session already removed when switching organizations away and back', async () => {
      // Realistic, not merely static: once `discordServers.remove` actually
      // runs, org-1's own binding stops being active — the same thing a real
      // `discordServers.list` would report afterward. Without this, the
      // eventual refetch below would hide the bug this test exists to catch
      // by coincidentally reporting "not installed" for its own reason.
      let removed = false
      listDiscordServers.mockImplementation((organizationId: string) =>
        Promise.resolve(
          organizationId === 'org-1' && !removed
            ? [
                {
                  serverId: 'guild-42',
                  organizationId: 'org-1',
                  installedByAccountId: 'account-1',
                  installedAt: Date.now(),
                  removedAt: null,
                },
              ]
            : []
        )
      )
      dispatchAction.mockImplementation(() => {
        removed = true
        return Promise.resolve({ result: undefined })
      })

      renderShell({
        account: MULTI_MEMBERSHIP_ACCOUNT,
        justInstalled: { organizationId: 'org-1', serverId: 'guild-42' },
        onSignedOut: vi.fn(),
      })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
      expect(await screen.findByText(/guild-42/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
      await screen.findByRole('button', { name: 'Install to Discord' })

      // The reviewer's own repro: switch away, then back — no reload in
      // between.
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'org-2' },
      })
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'org-1' },
      })

      // The bug's own window: synchronously after the switch back, before
      // the refetch resolves, `justInstalled` must not answer for this
      // server again — `removedServerId` (`pages/Shell.tsx`) is what this
      // asserts holds, without it this renders "Installed — server
      // guild-42" with a live Remove button that would then 404.
      expect(screen.queryByText(/guild-42/)).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Remove' })
      ).not.toBeInTheDocument()

      // And it settles correctly once the refetch itself resolves too.
      expect(
        await screen.findByRole('button', { name: 'Install to Discord' })
      ).toBeInTheDocument()
    })

    it('must-fix 2: refetches the Discord binding on every organization switch, not only on mount', async () => {
      listDiscordServers.mockImplementation((organizationId: string) =>
        Promise.resolve(
          organizationId === 'org-1'
            ? [
                {
                  serverId: 'guild-1',
                  organizationId: 'org-1',
                  installedByAccountId: 'account-1',
                  installedAt: Date.now(),
                  removedAt: null,
                },
              ]
            : []
        )
      )

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
      expect(await screen.findByText(/guild-1/)).toBeInTheDocument()

      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'org-2' },
      })

      // A second, org-2-scoped request actually happened — fetching only on
      // mount (`useEffect(..., [])`) would leave this never called with
      // 'org-2' at all.
      await waitFor(() =>
        expect(listDiscordServers).toHaveBeenCalledWith('org-2')
      )
      // And the panel reflects it — org-2 has no binding, so org-1's own
      // installed server must not still be showing.
      expect(
        await screen.findByRole('button', { name: 'Install to Discord' })
      ).toBeInTheDocument()
      expect(screen.queryByText(/guild-1/)).not.toBeInTheDocument()
    })

    it('cheap-fix: shows the active binding, not merely the first one in the list, when a removed binding is also present', async () => {
      // Order deliberately puts the removed binding first — `bindings[0]`
      // would pick it; only `.find((b) => b.removedAt === null)` picks the
      // active one that actually belongs here.
      listDiscordServers.mockResolvedValue([
        {
          serverId: 'guild-removed',
          organizationId: 'org-1',
          installedByAccountId: 'account-1',
          installedAt: Date.now() - 200_000,
          removedAt: Date.now() - 100_000,
        },
        {
          serverId: 'guild-active',
          organizationId: 'org-1',
          installedByAccountId: 'account-1',
          installedAt: Date.now() - 50_000,
          removedAt: null,
        },
      ])

      renderShell({ account: MULTI_MEMBERSHIP_ACCOUNT, onSignedOut: vi.fn() })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

      expect(await screen.findByText(/guild-active/)).toBeInTheDocument()
      expect(screen.queryByText(/guild-removed/)).not.toBeInTheDocument()
    })

    it('cheap-fix: a slow lookup that resolves after Remove does not resurrect the binding', async () => {
      dispatchAction.mockResolvedValue({ result: undefined })

      // The mount fetch never settles on its own — this test settles it by
      // hand, after Remove has already completed, standing in for a
      // response that started before the removal and only arrived after.
      let settleMountFetch:
        ((bindings: DiscordServerBindingSummary[]) => void) | undefined
      listDiscordServers.mockImplementation(
        () =>
          new Promise((resolve) => {
            settleMountFetch = resolve
          })
      )

      renderShell({
        account: MULTI_MEMBERSHIP_ACCOUNT,
        justInstalled: { organizationId: 'org-1', serverId: 'guild-42' },
        onSignedOut: vi.fn(),
      })
      openDrawer()
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
      // `justInstalled` is the immediate signal while the mount fetch above
      // is still in flight (this file's own regression test, above).
      expect(await screen.findByText(/guild-42/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
      await screen.findByRole('button', { name: 'Install to Discord' })

      // The original mount fetch — begun before Remove ran, still unsettled
      // — finally resolves now, reporting the binding as still active,
      // because that response was generated before the removal happened.
      // `discordFetchId`'s own increment in `handleRemove` (`pages/Shell.tsx`)
      // is what must make this land as a no-op.
      settleMountFetch?.([
        {
          serverId: 'guild-42',
          organizationId: 'org-1',
          installedByAccountId: 'account-1',
          installedAt: Date.now(),
          removedAt: null,
        },
      ])
      // Flush the microtask queue so the stale response's `.then` — the one
      // that must be ignored — has a chance to run before this asserts, the
      // same idiom `tests/projects.test.tsx`/`tests/courses.test.tsx` use
      // for the identical class of race.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(
        screen.getByRole('button', { name: 'Install to Discord' })
      ).toBeInTheDocument()
      expect(screen.queryByText(/guild-42/)).not.toBeInTheDocument()
    })

    it('cheap-fix: does not fetch a Discord binding for an organization the account is not a member of', async () => {
      renderShell({
        account: CONNECTED_NON_MEMBER_ACCOUNT,
        onSignedOut: vi.fn(),
      })
      await waitFor(() =>
        expect(listDiscordServers).toHaveBeenCalledWith('personal-org')
      )

      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })
      await screen.findByRole('heading', { name: 'Chat' })

      // `routes/actions.ts` refuses `discordServers.list` outright for a
      // caller with no membership — this must never even be attempted for
      // an organization the account is only connected to, not a member of.
      expect(listDiscordServers).not.toHaveBeenCalledWith('institution-org')
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
      // separator; the organization group (Discord, Team, Usage, Jobs)
      // follows it.
      const projects = screen.getByRole('button', { name: 'Projects' })
      const discord = screen.getByRole('button', { name: 'Discord' })
      expect(
        projects.compareDocumentPosition(separator) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(
        separator.compareDocumentPosition(discord) &
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
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })
      openDrawer()
      expect(screen.queryByRole('separator')).not.toBeInTheDocument()
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
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })
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
        await screen.findByRole('combobox', { name: 'Organization' })
      ).toHaveValue('personal-org')
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
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd-fa26',
      studentsRole: 'students-wd-fa26',
      promptId: null,
      instructions: null,
      model: null,
      vectorStoreId: null,
      maxRequestsPerDay: null,
      conversationScope: 'course',
      discordServerId: null,
      createdAt: 0,
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
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'org-2' },
      })

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
