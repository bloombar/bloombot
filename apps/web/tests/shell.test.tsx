/**
 * `pages/Shell.tsx` (WEB-3, WEB-4): which organization the panel is acting
 * in, and that the actively selected organization — not merely whichever one
 * the component happened to mount with — is what every subsequent request
 * carries. Before this file existed there was no test at all for `Shell.tsx`
 * (finding 2 of the WEB-1..6 rework): WEB-3's central claim went untested,
 * and `tests/organization-switcher.test.tsx` explicitly defers "what active
 * means" to this component.
 */

import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type {
  AccountSummary,
  DiscordServerBindingSummary,
  Project,
} from '../src/api/types.js'
import { Shell } from '../src/pages/Shell.js'
import { renderWithModal } from './helpers/render-with-modal.js'

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
    listDiscordServers,
    fetchOrganizationUsage,
    listMemberships,
    listJobs,
  }
})

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
})

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('Shell (WEB-3, WEB-4)', () => {
  it('with no install just completed, defaults to the first membership', () => {
    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-1'
    )
  })

  // TEN-8 regression: `justInstalled` must keep working as the *immediate*
  // signal it always was — the banner has to show right away, before
  // `listDiscordServers` has even resolved, or a fresh install would flash
  // "Install" for the round trip this slice added. `listDiscordServers`
  // itself is mocked to resolve with the same binding `justInstalled`
  // already named, matching what the server would actually report once
  // asked — so this also proves the fetched value does not contradict, or
  // flicker away, what `justInstalled` already showed.
  it('an install that just completed for a *different* organization than the first membership opens the panel on that organization, not the first one (finding 2 of the WEB-1..6 rework)', async () => {
    listDiscordServers.mockImplementation((organizationId: string) =>
      Promise.resolve(
        organizationId === 'org-2'
          ? [
              {
                serverId: 'guild-42',
                organizationId: 'org-2',
                installedByAccountId: 'account-1',
                installedAt: Date.now(),
                removedAt: null,
              },
            ]
          : []
      )
    )
    renderWithModal(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-2', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    // The switcher shows the organization the install actually bound —
    // before this fix it stayed on org-1 (memberships[0]) while the API had
    // bound the server to org-2.
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-2'
    )
    // And the installed banner is visible on first render of the Discord
    // tab, not only after a manual switch — `installedServerId` only
    // matches when `activeOrganizationId` equals
    // `justInstalled.organizationId`. (The Discord tab itself is not the
    // default one anymore — finding 10 — so this test opens it explicitly.)
    // This assertion runs before `listDiscordServers` has resolved (no
    // `await` above it) — proving the banner does not wait on the fetch.
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
    expect(screen.getByText(/guild-42/)).toBeInTheDocument()

    // Let the fetch settle before this test ends — otherwise its `.then`
    // fires after `cleanup()` has already unmounted this render.
    await waitFor(() =>
      expect(listDiscordServers).toHaveBeenCalledWith('org-2')
    )
  })

  it('a justInstalled organization the account is not actually a member of is ignored, defensively, in favour of the first membership', () => {
    renderWithModal(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-9', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-1'
    )
  })

  // WEB-25 — a redeemed join link opens directly on the joined course's own
  // organization and the Chat tab, not wherever this account's own first
  // membership happens to be (`CONNECTED_NON_MEMBER_ACCOUNT`'s own
  // `personal-org` — TEN-1's own personal organization, created for every
  // account, and exactly the organization that used to strand a redeemer on
  // Projects with nothing relevant there: `docs/SPEC.md`'s own WEB-25 names
  // this precise defect, "several clicks away behind a course picker they
  // have no reason to understand"). `joinedCourse.organizationId` is only
  // ever a *connected* organization here (LINK-10: a join-link redemption
  // enrols a person, not a membership), so this also proves the initializer
  // checks `connectedOrganizations`, not only `memberships` the way
  // `justInstalled`'s own check (above) does.
  it('a redeemed join link opens directly on that organization and the Chat tab, not the first membership', async () => {
    renderWithModal(
      <Shell
        account={CONNECTED_NON_MEMBER_ACCOUNT}
        joinedCourse={{
          organizationId: 'institution-org',
          courseId: 'course-1',
          alreadyEnrolled: false,
        }}
        onSignedOut={vi.fn()}
      />
    )

    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'institution-org'
    )
    // Fails without the fix: this shell's own default tab is 'projects',
    // which this connected-only organization cannot even offer.
    expect(
      await screen.findByRole('heading', { name: 'Chat' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('join-confirmation')).toHaveTextContent(
      "You're enrolled in A Course."
    )
  })

  it('a joinedCourse organization the account can neither administer nor reach is ignored, defensively, in favour of the first membership', () => {
    renderWithModal(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        joinedCourse={{
          organizationId: 'org-9',
          courseId: 'course-1',
          alreadyEnrolled: false,
        }}
        onSignedOut={vi.fn()}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-1'
    )
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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
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

    renderWithModal(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-2', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={onSignedOut} />
    )
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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={onSignedOut} />
    )
    await screen.findByText('Fall 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Fall 2026' }))
    await screen.findByRole('button', { name: 'New course' })
    fireEvent.click(screen.getByRole('button', { name: 'New course' }))
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'A course I never saved' },
    })

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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )

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
    expect(screen.getByLabelText('New project name')).toBeInTheDocument()
  })

  // ADMIN-1..3: a fourth tab, the same shape Discord/Projects/Chat already
  // take — switching to it renders `pages/Transcripts.tsx`, not the
  // Projects panel it defaulted to on mount.
  it('switches to the Transcripts tab', async () => {
    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })
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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })
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

    renderWithModal(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
    )
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
      renderWithModal(
        <Shell account={CONNECTED_NON_MEMBER_ACCOUNT} onSignedOut={vi.fn()} />
      )
      expect(
        screen.getByRole('combobox', { name: 'Organization' })
      ).toHaveValue('personal-org')
      expect(
        screen.getByRole('button', { name: 'Discord' })
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Transcripts' })
      ).toBeInTheDocument()
    })

    it('switching to the connected-only organization offers only Chat, and Chat is what actually renders', async () => {
      renderWithModal(
        <Shell account={CONNECTED_NON_MEMBER_ACCOUNT} onSignedOut={vi.fn()} />
      )

      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })

      // Discord, Projects and Transcripts are gone — not merely disabled —
      // once this organization is active.
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
      renderWithModal(
        <Shell account={CONNECTED_NON_MEMBER_ACCOUNT} onSignedOut={vi.fn()} />
      )
      // Select Discord while still on the membership organization...
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
      renderWithModal(
        <Shell account={CONNECTED_NON_MEMBER_ACCOUNT} onSignedOut={vi.fn()} />
      )
      fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
        target: { value: 'institution-org' },
      })
      await screen.findByRole('heading', { name: 'Chat' })

      fireEvent.click(screen.getByRole('button', { name: 'Home' }))

      // Still Chat — 'projects' (this shell's own ordinary home) is not a
      // screen this account can reach here.
      expect(
        screen.queryByRole('button', { name: 'Projects' })
      ).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument()
    })

    it('the switcher offers the connected organization labelled "connected", never a membership role it does not have', () => {
      renderWithModal(
        <Shell account={CONNECTED_NON_MEMBER_ACCOUNT} onSignedOut={vi.fn()} />
      )
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

      renderWithModal(
        <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Discord' }))

      // Not "Install to Discord" — a fetched binding this session never
      // created still renders as installed.
      expect(await screen.findByText(/guild-99/)).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Install to Discord' })
      ).not.toBeInTheDocument()

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

      renderWithModal(
        <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
      )
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

      renderWithModal(
        <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
      )
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

      renderWithModal(
        <Shell
          account={MULTI_MEMBERSHIP_ACCOUNT}
          justInstalled={{ organizationId: 'org-1', serverId: 'guild-42' }}
          onSignedOut={vi.fn()}
        />
      )
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

      renderWithModal(
        <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
      )
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

      renderWithModal(
        <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />
      )
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

      renderWithModal(
        <Shell
          account={MULTI_MEMBERSHIP_ACCOUNT}
          justInstalled={{ organizationId: 'org-1', serverId: 'guild-42' }}
          onSignedOut={vi.fn()}
        />
      )
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
      renderWithModal(
        <Shell account={CONNECTED_NON_MEMBER_ACCOUNT} onSignedOut={vi.fn()} />
      )
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
})
