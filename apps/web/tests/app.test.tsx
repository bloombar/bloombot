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

// `listProjects` is mocked here too, not just `fetchMe`/`completeDiscordInstall`
// — finding 10 of the WEB-7 rework changed `pages/Shell.tsx`'s default tab to
// 'projects' (`docs/DECISIONS.md` D-25), so the shell this file renders now
// mounts `ProjectsPanel` on first render, not only when a test opts into the
// Projects tab.
const { fetchMe, completeDiscordInstall, listProjects, redeemSignInLink } =
  vi.hoisted(() => ({
    fetchMe: vi.fn(),
    completeDiscordInstall: vi.fn(),
    listProjects: vi.fn(),
    redeemSignInLink: vi.fn(),
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
    redeemSignInLink,
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
      },
    })
    window.history.pushState(null, '', '/sign-in/a-token')

    renderWithModal(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Connect your account' })
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/connect/org-1')
  })
})
