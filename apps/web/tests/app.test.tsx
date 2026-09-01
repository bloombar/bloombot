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

import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/App.js'
import { ApiError } from '../src/api/client.js'
import { PENDING_INSTALL_ORG_KEY } from '../src/components/InstallButton.js'

const { fetchMe, completeDiscordInstall } = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  completeDiscordInstall: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, fetchMe, completeDiscordInstall }
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

    render(<App />)

    // The panel returns to the shell, acting in org-2 — the organization the
    // install actually bound the server to — with the install already
    // showing, not a fresh "Install to Discord" button.
    await screen.findByText(/guild-99/)
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-2'
    )
    expect(window.location.pathname).toBe('/')
  })

  it('an unreachable apps/api reports it and offers a retry, rather than hanging on "Loading…" forever (finding 3 of the WEB-1..6 rework)', async () => {
    fetchMe.mockRejectedValueOnce(new ApiError(0, { error: 'network_error' }))
    fetchMe.mockResolvedValueOnce({ account: null })

    render(<App />)

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
