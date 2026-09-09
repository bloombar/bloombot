/**
 * `pages/Connect.tsx` (LINK-6/7/8) — the panel's own connect screen. Signed
 * out, it renders `SignIn`, passing this page's own address as `SignIn`'s
 * `destination` prop (AUTH-6) so a later sign-in redemption returns here
 * regardless of which tab redeems it. Signed in, it offers Discord (begins
 * the OAuth round trip — a same-tab redirect that still uses
 * `PENDING_CONNECT_ORG_KEY`, unaffected by the AUTH-6 rework; the rest of
 * that flow is `discord-callback.test.tsx`'s own scenario) and an assistant
 * token, previewed before it is ever redeemed (LINK-6).
 *
 * LINK-7 (polish slice): the Discord status line — read from
 * `getPersonLinkStatus` on every mount, so it is durable across visits
 * rather than a flag threaded through the one post-OAuth navigation — and
 * the branding this screen now shows in both states.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Connect, PENDING_CONNECT_ORG_KEY } from '../src/pages/Connect.js'

const {
  beginDiscordPersonLink,
  previewMcpPersonLink,
  confirmMcpPersonLink,
  requestSignInLink,
  getPersonLinkStatus,
} = vi.hoisted(() => ({
  beginDiscordPersonLink: vi.fn(),
  previewMcpPersonLink: vi.fn(),
  confirmMcpPersonLink: vi.fn(),
  requestSignInLink: vi.fn(),
  getPersonLinkStatus: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    beginDiscordPersonLink,
    previewMcpPersonLink,
    confirmMcpPersonLink,
    requestSignInLink,
    getPersonLinkStatus,
  }
})

const ACCOUNT: AccountSummary = {
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
}

// Default for every signed-in test — not connected — since most of them are
// not exercising LINK-7's own status line; tests that are override it.
beforeEach(() => {
  getPersonLinkStatus.mockResolvedValue({ discord: { connected: false } })
})

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('Connect — signed out', () => {
  it('renders SignIn', () => {
    render(
      <Connect organizationId="org-1" account={null} onSignedIn={vi.fn()} />
    )

    expect(
      screen.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
  })

  // AUTH-6: fails without the fix — before `destination` existed, this
  // page's own return trip was a `sessionStorage` marker (`PENDING_CONNECT_ORG_KEY`,
  // this file's own former assertion here), which only ever survived a
  // sign-in redemption completing in the same tab that set it.
  it('requests a sign-in link with this page as the destination', async () => {
    requestSignInLink.mockResolvedValue(undefined)

    render(
      <Connect organizationId="org-1" account={null} onSignedIn={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'student@example.edu' },
    })
    // The consent checkbox gates both sign-in paths (`pages/SignIn.tsx`);
    // without ticking it the form will not submit at all.
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'student@example.edu',
        '/connect/org-1'
      )
    )
  })
})

describe('Connect — signed in — Discord (LINK-7)', () => {
  it('names the account signed in', () => {
    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )
    expect(screen.getByText(/student@example.edu/)).toBeInTheDocument()
  })

  it('begins the connect flow: stashes the organization and navigates to the authorization URL', async () => {
    beginDiscordPersonLink.mockResolvedValue({
      authorizationUrl: 'https://discord.test/oauth2/authorize?state=abc',
      expiresAt: Date.now() + 60_000,
    })
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    })

    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )
    // LINK-7 — the button only appears once the status fetch (mocked "not
    // connected" by this file's own `beforeEach`) resolves; `findByRole`
    // waits for it rather than assuming it is already there.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Connect Discord' })
    )

    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(beginDiscordPersonLink).toHaveBeenCalledWith('org-1')
    // `PENDING_CONNECT_ORG_KEY` still does this one job (this file's own
    // module comment: a same-tab redirect to Discord and back) — AUTH-6
    // only retired its *other* former job, surviving a sign-in redemption.
    expect(sessionStorage.getItem(PENDING_CONNECT_ORG_KEY)).toBe('org-1')
  })

  // Fails without the change: before LINK-7's own status read existed,
  // this screen always rendered the button, even for a caller whose
  // Discord identity is already connected — there was no server-sourced
  // signal to show anything else. No `username` here (cheap-fix 3, review
  // finding): `person_identities` has no username column
  // (`routes/person-link.ts`'s own doc comment on `GET /status`), so this
  // is the shape the real API actually sends, not a fixture it can never
  // produce.
  it('renders the connected status in place of the button once the server reports Discord connected', async () => {
    getPersonLinkStatus.mockResolvedValue({
      discord: { connected: true },
    })

    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    expect(await screen.findByText('Discord connected.')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Connect Discord' })
    ).not.toBeInTheDocument()
  })

  it('renders the button, not a connected status, while Discord is not connected', async () => {
    getPersonLinkStatus.mockResolvedValue({ discord: { connected: false } })

    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    expect(
      await screen.findByRole('button', { name: 'Connect Discord' })
    ).toBeInTheDocument()
  })

  // This paragraph was removed at the user's own request — nothing
  // replaces it.
  it('does not render the removed "Sends you to Discord..." paragraph', async () => {
    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    await screen.findByRole('button', { name: 'Connect Discord' })
    expect(
      screen.queryByText(
        "Sends you to Discord's own sign-in screen, then back here to confirm."
      )
    ).not.toBeInTheDocument()
  })

  // Fails without the change: before must-fix 1's own fix, an
  // ApiError-rejected status fetch left discordStatus undefined forever —
  // the ternary's "Loading..." branch never fell through to the button, so
  // this screen's whole primary action stayed unreachable until a manual
  // reload. A network blip, a 500, or an expired-session 401 (all
  // normalised to ApiError by api/client.ts) must instead fail open to the
  // button, with the error still shown.
  it('a failed status fetch fails open to the button, with the error shown', async () => {
    getPersonLinkStatus.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )

    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    expect(
      await screen.findByRole('button', { name: 'Connect Discord' })
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  // Fails without the change: before must-fix 2's own fix, switching
  // organizationId on this same component instance (what App.tsx's own
  // fixed-position render, with no key, actually does) left the previous
  // organization's own "connected" state on screen until the new
  // organization's response happened to land, rather than resetting to
  // loading immediately.
  it('resets to loading when organizationId changes, rather than showing the previous organization own stale status', async () => {
    getPersonLinkStatus.mockResolvedValueOnce({
      discord: { connected: true },
    })

    const { rerender } = render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )
    await screen.findByText('Discord connected.')

    let resolveSecond:
      ((value: { discord: { connected: boolean } }) => void) | undefined
    getPersonLinkStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        })
    )

    rerender(
      <Connect organizationId="org-2" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    expect(screen.queryByText('Discord connected.')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading')

    resolveSecond?.({ discord: { connected: false } })
    expect(
      await screen.findByRole('button', { name: 'Connect Discord' })
    ).toBeInTheDocument()
  })
})

describe('Connect — signed in — an assistant (LINK-6/8)', () => {
  it('previews before confirming — the token is not redeemed on Continue alone', async () => {
    previewMcpPersonLink.mockResolvedValue({
      preview: {
        organizationId: 'org-1',
        survivorPersonId: 'person-1',
        identity: { surface: 'mcp', externalId: 'assistant-1' },
        outcome: { kind: 'attach' },
      },
    })

    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Assistant token'), {
      target: { value: 'a-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(
      await screen.findByText(
        'This identity has not been connected to anyone yet — connecting will attach it to your account.'
      )
    ).toBeInTheDocument()
    expect(previewMcpPersonLink).toHaveBeenCalledWith('org-1', 'a-token')
    expect(confirmMcpPersonLink).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm connecting' }))
    await waitFor(() =>
      expect(confirmMcpPersonLink).toHaveBeenCalledWith('org-1', 'a-token')
    )
    expect(
      await screen.findByText('Your assistant is connected.')
    ).toBeInTheDocument()
  })

  it('a refused preview renders the same refusal every other refusal in this app renders', async () => {
    previewMcpPersonLink.mockRejectedValue(
      new ApiError(404, { error: 'person_link_not_found' })
    )

    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )
    fireEvent.change(screen.getByLabelText('Assistant token'), {
      target: { value: 'a-bad-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('explains what connecting an assistant is for, naming ChatGPT and Claude', () => {
    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    expect(screen.getByText(/ChatGPT/)).toBeInTheDocument()
    expect(screen.getByText(/Claude/)).toBeInTheDocument()
  })
})

describe('Connect — branding', () => {
  it('renders the logo and the Bloombot wordmark signed out', () => {
    render(
      <Connect organizationId="org-1" account={null} onSignedIn={vi.fn()} />
    )

    expect(screen.getByTestId('bloombot-logo')).toBeInTheDocument()
    expect(screen.getByText('Bloombot')).toBeInTheDocument()
  })

  it('renders the logo and the Bloombot wordmark signed in', () => {
    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    expect(screen.getByTestId('bloombot-logo')).toBeInTheDocument()
    expect(screen.getByText('Bloombot')).toBeInTheDocument()
  })
})
