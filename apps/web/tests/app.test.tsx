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

import { screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/App.js'
import { renderWithModal } from './helpers/render-with-modal.js'
import { ApiError } from '../src/api/client.js'
import { PENDING_INSTALL_ORG_KEY } from '../src/components/InstallButton.js'
import { PENDING_CONNECT_ORG_KEY } from '../src/pages/Connect.js'
import { PENDING_JOIN_LINK_KEY } from '../src/pages/JoinLink.js'

// `listProjects` is mocked here too, not just `fetchMe`/`completeDiscordInstall`
// — finding 10 of the WEB-7 rework changed `pages/Shell.tsx`'s default tab to
// 'projects' (`docs/DECISIONS.md` D-25), so the shell this file renders now
// mounts `ProjectsPanel` on first render, not only when a test opts into the
// Projects tab.
const {
  fetchMe,
  completeDiscordInstall,
  listProjects,
  fetchAdminOrganizations,
  redeemSignInLink,
  previewDiscordPersonLink,
  confirmDiscordPersonLink,
  redeemCourseJoinLink,
} = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  completeDiscordInstall: vi.fn(),
  listProjects: vi.fn(),
  fetchAdminOrganizations: vi.fn(),
  redeemSignInLink: vi.fn(),
  previewDiscordPersonLink: vi.fn(),
  confirmDiscordPersonLink: vi.fn(),
  redeemCourseJoinLink: vi.fn(),
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
    fetchAdminOrganizations,
    redeemSignInLink,
    previewDiscordPersonLink,
    confirmDiscordPersonLink,
    redeemCourseJoinLink,
  }
})

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
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
    fireEvent.click(screen.getByRole('button', { name: 'Discord' }))
    // The install is already showing, not a fresh "Install to Discord"
    // button.
    await screen.findByText(/guild-99/)
    expect(window.location.pathname).toBe('/')
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
    expect(
      screen.getByRole('button', { name: 'Connect Discord' })
    ).toBeInTheDocument()
    // Not the ordinary shell — no organization switcher, no nav.
    expect(
      screen.queryByRole('combobox', { name: 'Organization' })
    ).not.toBeInTheDocument()
  })

  // LINK-6 rework — a sign-in redemption used to always return to the
  // shell; a visitor who arrived at `/connect/:organizationId` signed out
  // (stashing `PENDING_CONNECT_ORG_KEY`, `pages/Connect.tsx`'s own doc
  // comment) needs that redemption to land back on the connect screen they
  // actually came for, not the shell they have no other reason to see yet.
  it('a sign-in redemption returns to the pending connect organization, not the shell', async () => {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'org-1')
    redeemSignInLink.mockResolvedValue({ accountId: 'account-1' })
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

describe('App — /join/:secret (ENRL-8)', () => {
  it('signed out, renders the join-link screen own sign-in prompt rather than the ordinary shell', async () => {
    fetchMe.mockResolvedValue({ account: null })
    window.history.pushState(null, '', '/join/secret-abc')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
    expect(sessionStorage.getItem(PENDING_JOIN_LINK_KEY)).toBe('secret-abc')
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

  // ENRL-8, the same LINK-6 rework reasoning as `/connect/:organizationId`
  // above: a visitor who arrived at `/join/:secret` signed out
  // (`JoinLink.tsx`'s own `PENDING_JOIN_LINK_KEY`) must return to that same
  // link, not the shell, once a sign-in redemption completes — proved here
  // by the join link actually being redeemed (with the pending secret),
  // which could only happen if the browser landed back on `JoinLink`
  // rather than going straight to the ordinary shell.
  it('a sign-in redemption returns to the pending join link, not straight to the shell', async () => {
    sessionStorage.setItem(PENDING_JOIN_LINK_KEY, 'secret-abc')
    redeemSignInLink.mockResolvedValue({ accountId: 'account-1' })
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
