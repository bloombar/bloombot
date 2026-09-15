/**
 * `pages/Connected.tsx` (LINK-11) — the confirmation `App.tsx`'s
 * `DiscordCallback` lands on once a Discord connect is confirmed, in place
 * of returning to `pages/Connect.tsx`'s own form. Signed out, it renders
 * `SignIn` with this page's own address as `destination` (AUTH-6), the
 * identical precedent `connect.test.tsx` already pins for `Connect.tsx`.
 * Signed in, it verifies the connection through `getPersonLinkStatus`
 * before naming it and offering Chat and MCP — never the "Connect an
 * assistant" form `Connect.tsx` shows — and redirects to `Connect.tsx`
 * instead of anywhere it cannot back up (LINK-11 rework, must-fix 4).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Connected } from '../src/pages/Connected.js'

const { requestSignInLink, getPersonLinkStatus } = vi.hoisted(() => ({
  requestSignInLink: vi.fn(),
  getPersonLinkStatus: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, requestSignInLink, getPersonLinkStatus }
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

// Default for every signed-in test — connected — since most of them are not
// exercising must-fix 4's own verification; tests that are override it.
beforeEach(() => {
  getPersonLinkStatus.mockResolvedValue({ discord: { connected: true } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Connected — signed out', () => {
  it('renders SignIn', () => {
    render(
      <Connected
        organizationId="org-1"
        account={null}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
    expect(getPersonLinkStatus).not.toHaveBeenCalled()
  })

  it('requests a sign-in link with this page as the destination', async () => {
    requestSignInLink.mockResolvedValue(undefined)

    render(
      <Connected
        organizationId="org-1"
        account={null}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'student@example.edu' },
    })
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'student@example.edu',
        '/connected/org-1'
      )
    )
  })
})

describe('Connected — signed in, verified connected (LINK-11 must-fix 4)', () => {
  // Fails without the change: before this slice, a confirmed Discord
  // connect landed back on `pages/Connect.tsx`, which still shows the
  // "Assistant token" field alongside a "Discord connected" status line —
  // this page must show neither.
  it('names the confirmed Discord connection and offers no "Assistant token" field', async () => {
    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      await screen.findByRole('heading', { name: 'Discord connected' })
    ).toBeInTheDocument()
    expect(screen.getByText(/message the bot in Discord/i)).toBeInTheDocument()
    expect(getPersonLinkStatus).toHaveBeenCalledWith('org-1')
    expect(screen.queryByLabelText('Assistant token')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Connect Discord' })
    ).not.toBeInTheDocument()
  })

  // The confirmation's own two onward links — fails without the change if
  // either builds the wrong address (this page's own `buildPath`, never a
  // hand-concatenated string).
  it('offers Chat and MCP links to the same organization', async () => {
    const navigate = vi.fn()
    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={navigate}
      />
    )

    const chatLink = await screen.findByRole('link', { name: 'Go to Chat' })
    expect(chatLink).toHaveAttribute('href', '/o/org-1/chat')
    const mcpLink = screen.getByRole('link', {
      name: 'Connect an assistant (MCP)',
    })
    expect(mcpLink).toHaveAttribute('href', '/o/org-1/mcp')

    fireEvent.click(chatLink)
    expect(navigate).toHaveBeenCalledWith({
      kind: 'chat',
      organizationId: 'org-1',
    })
  })

  // LINK-11/WEB-49 — the panel's own chrome, the same as every other
  // signed-in page.
  it('renders the panel own chrome — the hamburger and the profile control', async () => {
    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    await screen.findByRole('heading', { name: 'Discord connected' })
    expect(
      screen.getByRole('button', { name: 'Open navigation menu' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Account settings' })
    ).toBeInTheDocument()
  })

  it('shows a quiet loading state while the verification read is in flight, not the claim itself', () => {
    let resolveStatus:
      ((value: { discord: { connected: boolean } }) => void) | undefined
    getPersonLinkStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        })
    )

    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      screen.queryByRole('heading', { name: 'Discord connected' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    // Quiets an "update not wrapped in act" warning for the still-pending
    // promise this test never lets resolve.
    resolveStatus?.({ discord: { connected: true } })
  })
})

describe('Connected — signed in, not actually connected or unverifiable (LINK-11 must-fix 4)', () => {
  // Fails without the change: before this fix, this page asserted "Discord
  // connected" for whatever organization id the URL named, whether or not
  // the server actually agreed — this is the case where it does not.
  it('redirects to Connect.tsx rather than claiming a connection the server denies', async () => {
    getPersonLinkStatus.mockResolvedValue({ discord: { connected: false } })
    const navigate = vi.fn()

    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={navigate}
      />
    )

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        { kind: 'connect', organizationId: 'org-1' },
        { replace: true }
      )
    )
    expect(
      screen.queryByRole('heading', { name: 'Discord connected' })
    ).not.toBeInTheDocument()
  })

  // A refused or unreachable read gets the identical treatment — there is
  // no button on this page to fail open to, unlike `Connect.tsx`'s own
  // status line, so the safest landing is the page that does have one.
  it('redirects to Connect.tsx when the verification read is refused', async () => {
    getPersonLinkStatus.mockRejectedValue(
      new ApiError(500, { error: 'internal_error' })
    )
    const navigate = vi.fn()

    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={navigate}
      />
    )

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        { kind: 'connect', organizationId: 'org-1' },
        { replace: true }
      )
    )
  })
})
