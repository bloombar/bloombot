/**
 * `pages/Connect.tsx` (LINK-6/7/8) — the panel's own connect screen. Signed
 * out, it renders `SignIn` and stashes the organization id for `App.tsx`'s
 * own `returnToShell` to pick back up. Signed in, it offers Discord
 * (begins the OAuth round trip — the rest of that flow is
 * `discord-callback.test.tsx`'s own scenario) and an assistant token,
 * previewed before it is ever redeemed (LINK-6).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Connect, PENDING_CONNECT_ORG_KEY } from '../src/pages/Connect.js'

const { beginDiscordPersonLink, previewMcpPersonLink, confirmMcpPersonLink } =
  vi.hoisted(() => ({
    beginDiscordPersonLink: vi.fn(),
    previewMcpPersonLink: vi.fn(),
    confirmMcpPersonLink: vi.fn(),
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
}

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('Connect — signed out', () => {
  it('renders SignIn, and stashes the organization id for a later sign-in redemption to pick back up', () => {
    render(
      <Connect organizationId="org-1" account={null} onSignedIn={vi.fn()} />
    )

    expect(
      screen.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
    expect(sessionStorage.getItem(PENDING_CONNECT_ORG_KEY)).toBe('org-1')
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect Discord' }))

    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(beginDiscordPersonLink).toHaveBeenCalledWith('org-1')
    expect(sessionStorage.getItem(PENDING_CONNECT_ORG_KEY)).toBe('org-1')
  })

  // The pending marker exists only to survive a full-page navigation
  // (a sign-in redemption's own round trip) — once this screen already has
  // an account, a stale value left over from an earlier, unrelated visit
  // must not linger and redirect some later, unrelated sign-in back here.
  it('clears a stale pending marker once signed in, before Connect Discord is ever clicked', () => {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'some-other-org')

    render(
      <Connect organizationId="org-1" account={ACCOUNT} onSignedIn={vi.fn()} />
    )

    expect(sessionStorage.getItem(PENDING_CONNECT_ORG_KEY)).toBeNull()
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
})
