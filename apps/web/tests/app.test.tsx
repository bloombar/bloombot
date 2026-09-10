/**
 * `App.tsx` (WEB-1..4): the top-level routing between the sign-in screen,
 * the Discord callback, and the signed-in shell — and, per WEB-2, the
 * source of truth for whether a session exists at all. Before this file
 * existed there was no test at all for `App.tsx` (finding 2 of the WEB-1..6
 * rework): the round trip through Discord's own consent screen — where an
 * install begun for one organization must land the panel acting in *that*
 * organization, not merely the account's first one — was asserted nowhere,
 * and neither was `fetchMe()` rejecting outright (finding 3).
 */

import { screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/App.js'
import { renderWithModal } from './helpers/render-with-modal.js'
import { ApiError } from '../src/api/client.js'
import { PENDING_INSTALL_ORG_KEY } from '../src/components/InstallButton.js'
import { PENDING_CONNECT_ORG_KEY } from '../src/pages/Connect.js'

// `listProjects` is mocked here too, not just `fetchMe`/`completeDiscordInstall`
// — finding 10 of the WEB-7 rework changed `pages/Shell.tsx`'s default tab to
// 'projects' (`docs/DECISIONS.md` D-25), so the shell this file renders now
// mounts `ProjectsPanel` on first render, not only when a test opts into the
// Projects tab. `listDiscordServers` is mocked for the same reason (TEN-8):
// `Shell.tsx` now reads it on every mount, not only once the Discord tab is
// opened, so the one test below that renders the shell needs a resolved
// value or the fetch reaches this test's own unmocked `fetch` and fails as
// a genuine network error.
const {
  fetchMe,
  completeDiscordInstall,
  listProjects,
  listDiscordServers,
  fetchAdminOrganizations,
  redeemSignInLink,
  previewDiscordPersonLink,
  confirmDiscordPersonLink,
  redeemCourseJoinLink,
  redeemMembershipInvitation,
  listChatCourses,
  getChatMessages,
  requestSignInLink,
  getPersonLinkStatus,
} = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  completeDiscordInstall: vi.fn(),
  listProjects: vi.fn(),
  listDiscordServers: vi.fn(),
  fetchAdminOrganizations: vi.fn(),
  redeemSignInLink: vi.fn(),
  previewDiscordPersonLink: vi.fn(),
  confirmDiscordPersonLink: vi.fn(),
  redeemCourseJoinLink: vi.fn(),
  redeemMembershipInvitation: vi.fn(),
  // LINK-7: `Connect.tsx` now fetches this on every mount it reaches
  // (signed in) — every test below that lands on `/connect/:organizationId`
  // needs a resolved value or the fetch reaches this test's own unmocked
  // `fetch` and fails as a genuine network error, the same reason
  // `listDiscordServers`/`listProjects` above are mocked.
  getPersonLinkStatus: vi.fn(),
  // WEB-32/WEB-34 — `App.tsx`'s own home resolution now navigates a
  // redeemed join link straight to `/o/:organizationId/chat/:courseId`
  // (`resolveHomeRoute`), so the `Chat` screen it lands on actually mounts,
  // the same reason `listProjects`/`listDiscordServers` above are mocked.
  listChatCourses: vi.fn(),
  getChatMessages: vi.fn(),
  // WEB-34 — what a signed-out deep link actually carries: the destination
  // is handed to `requestSignInLink`, so this is where it can be observed.
  requestSignInLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    fetchMe,
    completeDiscordInstall,
    listProjects,
    listDiscordServers,
    fetchAdminOrganizations,
    redeemSignInLink,
    previewDiscordPersonLink,
    confirmDiscordPersonLink,
    redeemCourseJoinLink,
    redeemMembershipInvitation,
    listChatCourses,
    getChatMessages,
    requestSignInLink,
    getPersonLinkStatus,
  }
})

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

// Default for every test — not connected — since most of them are not
// exercising LINK-7's own status line; tests that are override it after
// this runs.
beforeEach(() => {
  getPersonLinkStatus.mockResolvedValue({ discord: { connected: false } })
})

describe('App (WEB-1..4)', () => {
  it('an install that completed for a second organization lands the panel acting in that organization, not the account first membership (finding 2 of the WEB-1..6 rework)', async () => {
    // The account belongs to two organizations — `org-1` is first, but the
    // install this test drives through was begun for `org-2`
    // (`components/InstallButton.tsx` stashes this in sessionStorage before
    // the top-level navigation to Discord — this test picks up from there,
    // the same way the browser actually returns from Discord's own consent
    // screen: a fresh page load).
    sessionStorage.setItem(PENDING_INSTALL_ORG_KEY, 'org-2')
    completeDiscordInstall.mockResolvedValue({ serverId: 'guild-99' })
    listProjects.mockResolvedValue([])
    // TEN-8: `Shell.tsx` reads this back too, now, not only `justInstalled`
    // — resolved with the same binding the callback just reported, so this
    // assertion (below) proves the two agree, not merely that the
    // *immediate* signal alone renders something.
    listDiscordServers.mockResolvedValue([
      {
        serverId: 'guild-99',
        organizationId: 'org-2',
        installedByAccountId: 'account-1',
        installedAt: Date.now(),
        removedAt: null,
      },
    ])
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        memberships: [
          {
            organizationId: 'org-1',
            organizationName: 'Org One',
            role: 'owner',
          },
          {
            organizationId: 'org-2',
            organizationName: 'Org Two',
            role: 'assistant',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(
      null,
      '',
      '/discord/callback?code=abc&state=xyz&guild_id=guild-99'
    )

    renderWithModal(<App />)

    // The panel returns to the shell, acting in org-2 — the organization the
    // install actually bound the server to — before checking the install
    // banner itself: the Discord tab is not the default one (finding 10),
    // so this opens it explicitly the way an instructor would.
    expect(
      await screen.findByRole('combobox', { name: 'Organization' })
    ).toHaveValue('org-2')
    // WEB-34: `/` is never a real address — it resolves, once the session
    // is known, to the account's own canonical landing address (Projects,
    // for a member) under whichever organization the install actually
    // bound — org-2, not org-1. Checked before navigating any further below
    // — clicking into the Discord tab is itself a real navigation now
    // (WEB-32) and moves the address on to `/o/org-2/discord`.
    expect(window.location.pathname).toBe('/o/org-2/projects')
    // WEB-29: Discord lives in the drawer now, not a header row — opened
    // via the hamburger before it can be clicked.
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
    // The install is already showing, not a fresh "Install to Discord"
    // button.
    await screen.findByText(/guild-99/)
  })

  // Defensive — `resolveHomeRoute` checks `justInstalled.organizationId`
  // against the account's own memberships before ever trusting it (a value
  // this app did not itself just hand back); an organization it does not
  // administer falls back to the first membership instead.
  it('a justInstalled organization the account is not actually a member of is ignored, defensively, falling back to the first membership', async () => {
    // `PENDING_INSTALL_ORG_KEY` names the organization `justInstalled` ends
    // up naming (`DiscordCallback.tsx`'s own `installOrganizationId`) — set
    // to an organization this account does not administer at all, standing
    // in for a stale or corrupted value in `sessionStorage`.
    sessionStorage.setItem(PENDING_INSTALL_ORG_KEY, 'org-9')
    completeDiscordInstall.mockResolvedValue({ serverId: 'guild-9' })
    listProjects.mockResolvedValue([])
    listDiscordServers.mockResolvedValue([])
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        memberships: [
          {
            organizationId: 'org-1',
            organizationName: 'Org One',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(
      null,
      '',
      '/discord/callback?code=abc&state=xyz&guild_id=guild-9'
    )

    renderWithModal(<App />)

    expect(
      await screen.findByTestId('organization-switcher')
    ).toHaveTextContent('Org One')
    expect(window.location.pathname).toBe('/o/org-1/projects')
  })

  it('an unreachable apps/api reports it and offers a retry, rather than hanging on "Loading…" forever (finding 3 of the WEB-1..6 rework)', async () => {
    fetchMe.mockRejectedValueOnce(new ApiError(0, { error: 'network_error' }))
    fetchMe.mockResolvedValueOnce({ account: null })

    renderWithModal(<App />)

    expect(
      await screen.findByText(
        'Could not reach Bloombot. Check your connection and try again.'
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await screen.findByRole('heading', { name: 'Sign in to Bloombot' })
    expect(fetchMe).toHaveBeenCalledTimes(2)
  })

  // ADMIN-4 — reached at `/platform-admin`, outside `Shell`'s own organization-scoped
  // tabs (`pages/Admin.tsx`'s own module comment has why).
  it('a signed-in account visiting /platform-admin sees the platform-administrator console, not the ordinary shell', async () => {
    window.history.replaceState(null, '', '/platform-admin')
    fetchMe.mockResolvedValue({
      account: { id: 'account-1', memberships: [], connectedOrganizations: [] },
    })
    fetchAdminOrganizations.mockResolvedValue({
      organizations: [],
      platformHealth: {
        bot: { reachable: true },
        worker: { reachable: true },
        api: { reachable: true },
      },
    })

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Platform administration' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: 'Organization' })
    ).not.toBeInTheDocument()
  })
})

describe('App — /connect/:organizationId (LINK-6/7)', () => {
  it('signed out, renders the connect screen own sign-in prompt rather than the ordinary shell', async () => {
    fetchMe.mockResolvedValue({ account: null })
    window.history.pushState(null, '', '/connect/org-1')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
  })

  it('signed in, renders the connect screen offering to connect Discord — not the ordinary shell', async () => {
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/connect/org-1')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Connect your account' })
    ).toBeInTheDocument()
    // LINK-7 — the button only appears once the status fetch (mocked "not
    // connected" by this file's own top-level `beforeEach`) resolves;
    // `findByRole` waits for it rather than assuming it is already there.
    expect(
      await screen.findByRole('button', { name: 'Connect Discord' })
    ).toBeInTheDocument()
    // Not the ordinary shell — no organization switcher, no nav.
    expect(
      screen.queryByRole('combobox', { name: 'Organization' })
    ).not.toBeInTheDocument()
  })

  // AUTH-6 rework — a sign-in redemption used to always return to the
  // shell; a visitor who arrived at `/connect/:organizationId` signed out
  // needs that redemption to land back on the connect screen they actually
  // came for, not the shell they have no other reason to see yet. The
  // destination now comes off the redeemed token itself (`Connect.tsx`'s own
  // `destination` prop to `SignIn`), not a `sessionStorage` marker this test
  // would otherwise have to stash — proving, incidentally, that this no
  // longer depends on anything this same browsing context wrote earlier
  // (`app.test.tsx`'s own stand-in for AUTH-6's cross-tab case; the real
  // thing is `e2e/join-link.spec.ts`'s own two-tab scenario).
  it('a sign-in redemption returns to the connect organization the token itself named, not the shell', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/connect/org-1',
    })
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Connect your account' })
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/connect/org-1')
  })

  // Rework finding 8 — `DiscordCallback.tsx`'s own doc comment promises a
  // confirmed connect returns the browser to this same organization's own
  // connect screen. Before the fix, `onConnected` was `returnToShell`
  // itself, which reads a `sessionStorage` key `DiscordCallback.tsx`'s own
  // preview step had *already* deleted — so a freshly connected student
  // landed on the ordinary shell instead, silently: every existing test
  // stayed green because none of them checked where a confirmed connect
  // actually lands.
  it('a confirmed Discord connect returns to this organization own connect screen, not the ordinary shell', async () => {
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    previewDiscordPersonLink.mockResolvedValue({
      preview: {
        organizationId: 'org-1',
        survivorPersonId: 'person-1',
        identity: { surface: 'discord', externalId: 'snowflake-1' },
        outcome: { kind: 'attach' },
      },
      discordUsername: 'a-student',
    })
    confirmDiscordPersonLink.mockResolvedValue({ connected: true })
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'org-1')
    window.history.pushState(null, '', '/discord/callback?code=abc&state=xyz')

    renderWithModal(<App />)

    const confirmButton = await screen.findByRole('button', {
      name: 'Confirm connecting',
    })
    fireEvent.click(confirmButton)

    await screen.findByRole('heading', { name: 'Connect your account' })
    expect(window.location.pathname).toBe('/connect/org-1')
  })
})

// AUTH-6 rework, cheap-fix — `returnToShell`'s own `isSameOriginPath` check
// (`App.tsx`, its own module comment calls this "the one gate between a
// caller-supplied string and the browser's own address bar") is pinned
// directly here, against the same two adversarial values
// `packages/auth/tests/tokens.test.ts` asserts its own copy of the check
// against — deliberately shared, not two independently invented examples:
// the point is that both copies of `isSameOriginPath` refuse the same
// inputs. Fails without the fix if this component ever navigates to a
// server-supplied `destination` without checking it first.
describe('App — a redeemed destination that is not a same-origin path is refused before navigating (AUTH-6)', () => {
  it.each(['//evil.example', '/\\evil.example'])(
    'does not navigate to an off-origin destination (%s) — falls back to the ordinary shell instead',
    async (destination) => {
      redeemSignInLink.mockResolvedValue({
        accountId: 'account-1',
        destination,
      })
      listProjects.mockResolvedValue([])
      listDiscordServers.mockResolvedValue([])
      fetchMe.mockResolvedValue({
        account: {
          id: 'account-1',
          email: 'student@example.edu',
          memberships: [
            {
              organizationId: 'personal-org',
              organizationName: 'Student',
              role: 'owner',
            },
          ],
          connectedOrganizations: [],
        },
      })
      window.history.pushState(null, '', '/sign-in/a-token')

      renderWithModal(<App />)

      // The ordinary shell — not the off-origin address, and not left on
      // `/sign-in/a-token` either (redemption itself still ran and
      // succeeded; only the *navigation* it would otherwise have taken is
      // refused).
      expect(
        await screen.findByTestId('organization-switcher')
      ).toBeInTheDocument()
      // WEB-34: `/` resolves to this account's own canonical landing
      // address — Projects, under its one membership organization.
      expect(window.location.pathname).toBe('/o/personal-org/projects')
    }
  )
})

// WEB-44 — a reported production bug: signing in landed on
// `/o/<organizationId>/projects` and rendered `NotFound`, for an
// organization id the reporter believed did not exist. The actual cause is
// `returnToShell` navigating to a sign-in token's own carried destination
// before this account's memberships/connections are known — a stale
// destination (the reporter's case: a locally reset database) then named an
// organization this account cannot reach, and WEB-32's own no-leak check
// (correct for a typed bad address) rendered `NotFound` for it instead.
// These pin the fix: the destination is now resolved against the session
// once it is actually known, falling back to the account's own default
// organization rather than showing `NotFound` for a delivery this app
// itself made.
describe('App — WEB-44: a sign-in destination naming an organization this account cannot reach', () => {
  it('falls back to the account own default organization, not NotFound', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      // Stands in for the reported case exactly: an organization id absent
      // from this account's own memberships and connections, indistinguishable
      // to this app from one that never existed (TEN-5).
      destination: '/o/stale-org/projects',
    })
    listProjects.mockResolvedValue([])
    listDiscordServers.mockResolvedValue([])
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    expect(
      await screen.findByTestId('organization-switcher')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('not-found-page')).not.toBeInTheDocument()
    // `resolveHomeRoute`'s own default — the account's first membership.
    expect(window.location.pathname).toBe('/o/personal-org/projects')
  })

  it('an account with no memberships and no connections at all lands on /account, exactly as resolveHomeRoute already arranges', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/o/stale-org/projects',
    })
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    await screen.findByRole('heading', { name: 'Account' })
    expect(screen.queryByTestId('not-found-page')).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/account')
  })

  it('still lands on exactly the destination when the account can reach it — the existing behaviour, unregressed', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/o/org-2/projects',
    })
    listProjects.mockResolvedValue([])
    listDiscordServers.mockResolvedValue([])
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
          {
            organizationId: 'org-2',
            organizationName: 'Org Two',
            role: 'assistant',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    expect(
      await screen.findByTestId('organization-switcher')
    ).toHaveTextContent('Org Two')
    expect(window.location.pathname).toBe('/o/org-2/projects')
  })

  // The reachable-via-connection-only case `resolveHomeRoute` already
  // treats specially (this file's own module comment on why it falls back
  // one step further than a membership): a destination naming Projects for
  // an organization this account only has a connected identity for is
  // reachable (no NotFound), but `Shell`'s own `effectiveTab` restriction —
  // unchanged by this slice — forces it to Chat, and moves the address on
  // to match, exactly like `resolveHomeRoute` picks Chat, not Projects, for
  // a connected-only organization.
  it('a destination naming an organization the account only has a connected identity for resolves to Chat, not Projects', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/o/institution-org/projects',
    })
    listChatCourses.mockResolvedValue([])
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [],
        connectedOrganizations: [
          {
            organizationId: 'institution-org',
            organizationName: 'A University',
          },
        ],
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    expect(
      await screen.findByText(
        'You are not enrolled in a course here yet. Ask your instructor to add you.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('not-found-page')).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/o/institution-org/chat')
  })

  // The WEB-32 no-leak guarantee itself, asserted at this level: an address
  // a signed-in person *navigates to* (not one delivered by a sign-in
  // redemption) naming an organization they cannot reach must still render
  // `NotFound` — this fix only changes what a sign-in redemption does with
  // an unreachable destination, not what `isShellRoute`'s own check does
  // for anything else.
  it('navigating directly to an unreachable organization address still renders NotFound, not a silent redirect', async () => {
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/o/stale-org/projects')

    renderWithModal(<App />)

    expect(await screen.findByTestId('not-found-page')).toBeInTheDocument()
    expect(
      screen.queryByTestId('organization-switcher')
    ).not.toBeInTheDocument()
  })

  // Review finding 1 — a `refreshSession()` that does not resolve
  // `signed-in` (an API restart between the redemption itself succeeding
  // and the follow-up `/auth/me`, here) used to leave the address at
  // `/sign-in/:token` forever: `RedeemLink` kept rendering "Signing you
  // in…" over a token this very redemption already spent, with no error
  // and no way to retry — a permanent spinner, not merely a slow one. Fails
  // without the fix: the destination navigation used to be gated on
  // `session.kind === 'signed-in'`, which this outcome never reaches.
  it('a failing /auth/me right after redemption shows the unreachable retry screen, not a permanent "Signing you in…"', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/o/org-1/projects',
    })
    // The mount's own `refreshSession()` (App.tsx's first effect) runs
    // before the token is ever redeemed — signed out, the ordinary case for
    // a cold `/sign-in/:token` load — and the *second* call, the one
    // `returnToShell` starts once redemption succeeds, is the one that
    // fails.
    fetchMe.mockResolvedValueOnce({ account: null })
    fetchMe.mockRejectedValueOnce(new ApiError(0, { error: 'network_error' }))
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    expect(
      await screen.findByText(
        'Could not reach Bloombot. Check your connection and try again.'
      )
    ).toBeInTheDocument()
    // The address still moved on from the spent token — matching what this
    // screen already does regardless of route (it is not scoped to one).
    expect(window.location.pathname).toBe('/o/org-1/projects')
  })

  // Review finding 2 — the reported bug's own exact shape, reproduced
  // directly: a *second* account's sign-in token, redeemed in a tab that
  // already held a *first* account's live session. The ordering is forced
  // rather than hoped for: account A's own session (the mount's own
  // `refreshSession()`) is allowed to resolve and land *before* the
  // redemption's own `refreshSession()` call — its `fetchMe` is held open
  // on a promise this test resolves by hand — so any code that reads
  // ambient `session` state instead of the value this exact call produced
  // has every opportunity to read A. Fails without the fix: resolving the
  // destination against whichever session happened to already be sitting
  // in this component (A's, unrelated to the token just redeemed) rather
  // than the one this redemption's own `/auth/me` call produced (B)
  // rendered `NotFound` for an address B could reach perfectly well — the
  // exact symptom this slice exists to eliminate.
  it('a sign-in token for a different account than the one already loaded in this tab lands on that account own organization, not NotFound', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-b',
      destination: '/o/org-b/projects',
    })
    listProjects.mockResolvedValue([])
    listDiscordServers.mockResolvedValue([])

    let resolveSecondFetchMe:
      ((value: { account: unknown }) => void) | undefined
    fetchMe
      // First call — the mount's own `refreshSession()` — account A,
      // already signed in in this tab, a member of `org-a` only. Resolves
      // immediately, deliberately, so A's session has every chance to land
      // before B's own call below ever does.
      .mockImplementationOnce(() =>
        Promise.resolve({
          account: {
            id: 'account-a',
            email: 'a@example.edu',
            memberships: [
              {
                organizationId: 'org-a',
                organizationName: 'Org A',
                role: 'owner',
              },
            ],
            connectedOrganizations: [],
          },
        })
      )
      // Second call — `returnToShell`'s own, once redemption succeeds —
      // account B, a member of `org-b` only; the two accounts share no
      // organization at all. Held open until this test resolves it below,
      // by hand, well after A's own session has already committed.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondFetchMe = resolve
          })
      )
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    // The redemption itself has run (`redeemSignInLink` called), and A's
    // own session — the mount's `refreshSession()`, the first `fetchMe`
    // call above — has had every microtask turn available to it to land,
    // before B's own `fetchMe` (the second call, still held open) is ever
    // allowed to resolve.
    await vi.waitFor(() => expect(redeemSignInLink).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    resolveSecondFetchMe!({
      account: {
        id: 'account-b',
        email: 'b@example.edu',
        memberships: [
          { organizationId: 'org-b', organizationName: 'Org B', role: 'owner' },
        ],
        connectedOrganizations: [],
      },
    })

    expect(
      await screen.findByTestId('organization-switcher')
    ).toHaveTextContent('Org B')
    expect(window.location.pathname).toBe('/o/org-b/projects')
  })

  // "Also fix" — both branches of `returnToShell`'s own destination
  // handling replace the current history entry rather than pushing one, so
  // Back from the shell never lands on the spent, single-use token
  // (`/sign-in/:token`) — the same WEB-34 discipline every other entry
  // point above `ShellRoute`/`'home'` already holds itself to.
  describe('replace discipline (WEB-34)', () => {
    it('a reachable destination replaces the sign-in address rather than pushing a new entry', async () => {
      redeemSignInLink.mockResolvedValue({
        accountId: 'account-1',
        destination: '/o/personal-org/projects',
      })
      listProjects.mockResolvedValue([])
      listDiscordServers.mockResolvedValue([])
      fetchMe.mockResolvedValue({
        account: {
          id: 'account-1',
          email: 'student@example.edu',
          memberships: [
            {
              organizationId: 'personal-org',
              organizationName: 'Student',
              role: 'owner',
            },
          ],
          connectedOrganizations: [],
        },
      })
      // `replaceState` here, not `pushState` — this is establishing the
      // cold-load address the test starts from, not the navigation under
      // test, and a lingering `pushState` spy from an earlier test in this
      // file (`vi.spyOn` returns the same spy on a second call against an
      // already-spied method, so an *unspied* call here would be silently
      // attributed to whichever test spied first) must never be able to
      // record it.
      window.history.replaceState(null, '', '/sign-in/a-token')
      const pushState = vi.spyOn(window.history, 'pushState')
      const replaceState = vi.spyOn(window.history, 'replaceState')

      renderWithModal(<App />)

      await screen.findByTestId('organization-switcher')
      expect(window.location.pathname).toBe('/o/personal-org/projects')
      expect(pushState).not.toHaveBeenCalled()
      expect(replaceState).toHaveBeenCalled()
    })

    it('an unreachable destination falling back to the default organization also replaces, not pushes', async () => {
      redeemSignInLink.mockResolvedValue({
        accountId: 'account-1',
        destination: '/o/stale-org/projects',
      })
      listProjects.mockResolvedValue([])
      listDiscordServers.mockResolvedValue([])
      fetchMe.mockResolvedValue({
        account: {
          id: 'account-1',
          email: 'student@example.edu',
          memberships: [
            {
              organizationId: 'personal-org',
              organizationName: 'Student',
              role: 'owner',
            },
          ],
          connectedOrganizations: [],
        },
      })
      // `replaceState` here, not `pushState` — this is establishing the
      // cold-load address the test starts from, not the navigation under
      // test, and a lingering `pushState` spy from an earlier test in this
      // file (`vi.spyOn` returns the same spy on a second call against an
      // already-spied method, so an *unspied* call here would be silently
      // attributed to whichever test spied first) must never be able to
      // record it.
      window.history.replaceState(null, '', '/sign-in/a-token')
      const pushState = vi.spyOn(window.history, 'pushState')
      const replaceState = vi.spyOn(window.history, 'replaceState')

      renderWithModal(<App />)

      await screen.findByTestId('organization-switcher')
      expect(window.location.pathname).toBe('/o/personal-org/projects')
      expect(pushState).not.toHaveBeenCalled()
      expect(replaceState).toHaveBeenCalled()
    })
  })
})

describe('App — /join/:secret (ENRL-8)', () => {
  it('signed out, renders the join-link screen own sign-in prompt rather than the ordinary shell', async () => {
    fetchMe.mockResolvedValue({ account: null })
    window.history.pushState(null, '', '/join/secret-abc')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
  })

  it('signed in, redeems the link rather than rendering the ordinary shell', async () => {
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    // Never resolves in this test — asserting the pending "Joining…" state
    // (below) needs the redemption to still be in flight; a resolved mock
    // would race the assertion against `JoinLink`'s own `onRedeemed` (which
    // navigates away to the shell, `pages/JoinLink.tsx`'s own module
    // comment).
    redeemCourseJoinLink.mockReturnValue(new Promise(() => undefined))
    window.history.pushState(null, '', '/join/secret-abc')

    renderWithModal(<App />)

    await vi.waitFor(() =>
      expect(redeemCourseJoinLink).toHaveBeenCalledWith('secret-abc')
    )
    // Not the ordinary shell — no organization switcher, since redemption
    // has not resolved.
    expect(
      screen.queryByRole('combobox', { name: 'Organization' })
    ).not.toBeInTheDocument()
  })

  // AUTH-6, the same rework reasoning as `/connect/:organizationId` above: a
  // visitor who arrived at `/join/:secret` signed out must return to that
  // same link, not the shell, once a sign-in redemption completes — proved
  // here by the join link actually being redeemed (with the secret the
  // *token* itself named), which could only happen if the browser landed
  // back on `JoinLink` rather than going straight to the ordinary shell.
  it('a sign-in redemption returns to the join link the token itself named, not straight to the shell', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/join/secret-abc',
    })
    redeemCourseJoinLink.mockReturnValue(new Promise(() => undefined))
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    await vi.waitFor(() =>
      expect(redeemCourseJoinLink).toHaveBeenCalledWith('secret-abc')
    )
    expect(window.location.pathname).toBe('/join/secret-abc')
  })
})

// WEB-25/WEB-32/WEB-34: `resolveHomeRoute` is what now decides which
// organization and tab `/` resolves to — before this slice that logic lived
// in `pages/Shell.tsx`'s own `activeOrganizationId`/`activeTab`
// initializers; moved here because a `useState` initializer cannot itself
// produce a real, bookmarkable address the way `App.tsx`'s own `navigate`
// can.
describe('App — / home resolution (WEB-25, WEB-34)', () => {
  it('a redeemed join link resolves home to that organization’s own Chat, with the joined course already selected', async () => {
    redeemCourseJoinLink.mockResolvedValue({
      organizationId: 'institution-org',
      courseId: 'course-1',
      alreadyEnrolled: false,
    })
    listChatCourses.mockResolvedValue([{ id: 'course-1', title: 'A Course' }])
    getChatMessages.mockResolvedValue([])
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'student@example.edu',
        // The account's own personal organization (TEN-1) is first, and
        // would otherwise be `resolveHomeRoute`'s own fallback — this test
        // proves the joined organization wins instead, exactly like
        // `pages/Shell.tsx`'s own former initializer used to.
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Student',
            role: 'owner',
          },
        ],
        connectedOrganizations: [
          {
            organizationId: 'institution-org',
            organizationName: 'A University',
          },
        ],
      },
    })
    window.history.pushState(null, '', '/join/secret-abc')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Chat' })
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/o/institution-org/chat/course-1')
    expect(screen.getByTestId('organization-switcher')).toHaveTextContent(
      'A University'
    )
  })

  // Defensive — `resolveHomeRoute` checks `joinedCourse.organizationId`
  // against the account's own memberships/connections before ever trusting
  // it, the same way `justInstalled` is checked in the Discord install test
  // above; a value naming an organization the account cannot reach at all
  // falls back to the first membership instead.
  it('a joinedCourse organization the account can neither administer nor reach is ignored, defensively, falling back to the first membership', async () => {
    redeemCourseJoinLink.mockResolvedValue({
      organizationId: 'org-9',
      courseId: 'course-1',
      alreadyEnrolled: false,
    })
    listProjects.mockResolvedValue([])
    listDiscordServers.mockResolvedValue([])
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'instructor@example.edu',
        memberships: [
          {
            organizationId: 'org-1',
            organizationName: 'Org One',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/join/secret-abc')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Projects' })
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/o/org-1/projects')
  })
})

describe('App — /invitations/:secret (ENRL-10)', () => {
  it('signed out, renders the invitation screen own sign-in prompt rather than the ordinary shell', async () => {
    fetchMe.mockResolvedValue({ account: null })
    window.history.pushState(null, '', '/invitations/secret-abc')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
  })

  it('signed in, redeems the invitation rather than rendering the ordinary shell', async () => {
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'colleague@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Colleague',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    // Never resolves in this test — the same "assert the pending state
    // without racing the navigate-away" reasoning `/join/:secret`'s own
    // identical case gives, above.
    redeemMembershipInvitation.mockReturnValue(new Promise(() => undefined))
    window.history.pushState(null, '', '/invitations/secret-abc')

    renderWithModal(<App />)

    await vi.waitFor(() =>
      expect(redeemMembershipInvitation).toHaveBeenCalledWith('secret-abc')
    )
    expect(
      screen.queryByRole('combobox', { name: 'Organization' })
    ).not.toBeInTheDocument()
  })

  // AUTH-6, rework — found in review: this used to be the one entry point
  // AUTH-6 left behind, still returning through a same-tab-only
  // `sessionStorage` marker (`PENDING_INVITATION_KEY`) this test used to
  // stash itself before rendering. Rewritten to the identical shape
  // `/connect/:organizationId` and `/join/:secret` above already prove
  // AUTH-6 by: no `sessionStorage` write happens anywhere in this test at
  // all — `destination` comes only from the redeemed token
  // (`redeemSignInLink`'s own mocked response), which is exactly what
  // proves this no longer depends on anything this same browsing context
  // wrote earlier (this file's own stand-in for AUTH-6's cross-tab case;
  // the real thing is `e2e/membership-invitation-panel.spec.ts`'s own
  // two-tab scenario, below).
  it('a sign-in redemption returns to the invitation the token itself named, not straight to the shell', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/invitations/secret-abc',
    })
    redeemMembershipInvitation.mockReturnValue(new Promise(() => undefined))
    fetchMe.mockResolvedValue({
      account: {
        id: 'account-1',
        email: 'colleague@example.edu',
        memberships: [
          {
            organizationId: 'personal-org',
            organizationName: 'Colleague',
            role: 'owner',
          },
        ],
        connectedOrganizations: [],
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    await vi.waitFor(() =>
      expect(redeemMembershipInvitation).toHaveBeenCalledWith('secret-abc')
    )
    expect(window.location.pathname).toBe('/invitations/secret-abc')
  })
})

// WEB-34 (review finding) — a bookmark or a shared link followed while
// signed out asks for a sign-in, and the address must ride along on the
// issued token, so redeeming the emailed link lands on the screen the
// visitor actually clicked rather than on home resolution's default.
describe('App — a deep link followed while signed out keeps its address', () => {
  beforeEach(() => {
    fetchMe.mockResolvedValue({ account: null })
    requestSignInLink.mockResolvedValue(undefined)
  })

  it('carries the address on the sign-in request', async () => {
    window.history.replaceState(null, '', '/o/org-1/projects/project-1')

    renderWithModal(<App />)
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'reader@example.edu' },
    })
    // The consent checkbox gates both sign-in paths (`pages/SignIn.tsx`);
    // without ticking it the form will not submit at all.
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await waitFor(() => {
      expect(requestSignInLink).toHaveBeenCalledWith(
        'reader@example.edu',
        '/o/org-1/projects/project-1'
      )
    })
  })

  it('carries a parseable address even when the link arrived with a query string, rather than one that would sign the visitor in onto not-found', async () => {
    window.history.replaceState(
      null,
      '',
      '/o/org-1/projects/project-1?utm_source=email'
    )

    renderWithModal(<App />)
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'reader@example.edu' },
    })
    // The consent checkbox gates both sign-in paths (`pages/SignIn.tsx`);
    // without ticking it the form will not submit at all.
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await waitFor(() => {
      expect(requestSignInLink).toHaveBeenCalledWith(
        'reader@example.edu',
        '/o/org-1/projects/project-1'
      )
    })
  })

  it('carries nothing at all for an address this app cannot parse back', async () => {
    window.history.replaceState(null, '', '/nothing-here')

    renderWithModal(<App />)
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'reader@example.edu' },
    })
    // The consent checkbox gates both sign-in paths (`pages/SignIn.tsx`);
    // without ticking it the form will not submit at all.
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await waitFor(() => {
      expect(requestSignInLink).toHaveBeenCalledWith(
        'reader@example.edu',
        undefined
      )
    })
  })
})
