/**
 * `pages/Connect.tsx` (LINK-6/7/8) — the panel's own connect screen. Signed
 * out, it renders `SignIn`, passing this page's own address as `SignIn`'s
 * `destination` prop (AUTH-6) so a later sign-in redemption returns here
 * regardless of which tab redeems it. Signed in, it offers Discord (begins
 * the OAuth round trip — a same-tab redirect that still uses
 * `PENDING_CONNECT_ORG_KEY`, unaffected by the AUTH-6 rework; the rest of
 * that flow is `discord-callback.test.tsx`'s own scenario) and an assistant
 * token, previewed before it is ever redeemed (LINK-6).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Connect, PENDING_CONNECT_ORG_KEY } from '../src/pages/Connect.js'

const {
  beginDiscordPersonLink,
  previewMcpPersonLink,
  confirmMcpPersonLink,
  requestSignInLink,
} = vi.hoisted(() => ({
  beginDiscordPersonLink: vi.fn(),
  previewMcpPersonLink: vi.fn(),
  confirmMcpPersonLink: vi.fn(),
  requestSignInLink: vi.fn(),
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect Discord' }))

    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(beginDiscordPersonLink).toHaveBeenCalledWith('org-1')
    // `PENDING_CONNECT_ORG_KEY` still does this one job (this file's own
    // module comment: a same-tab redirect to Discord and back) — AUTH-6
    // only retired its *other* former job, surviving a sign-in redemption.
    expect(sessionStorage.getItem(PENDING_CONNECT_ORG_KEY)).toBe('org-1')
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
