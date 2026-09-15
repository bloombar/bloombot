/**
 * `pages/Connected.tsx` (LINK-11) — the confirmation `App.tsx`'s
 * `DiscordCallback` lands on once a Discord connect is confirmed, in place
 * of returning to `pages/Connect.tsx`'s own form. Signed out, it renders
 * `SignIn` with this page's own address as `destination` (AUTH-6), the
 * identical precedent `connect.test.tsx` already pins for `Connect.tsx`.
 * Signed in, it names the confirmed connection and offers Chat and MCP —
 * never the "Connect an assistant" form `Connect.tsx` shows.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccountSummary } from '../src/api/types.js'
import { Connected } from '../src/pages/Connected.js'

const { requestSignInLink } = vi.hoisted(() => ({
  requestSignInLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, requestSignInLink }
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

    await vi.waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'student@example.edu',
        '/connected/org-1'
      )
    )
  })
})

describe('Connected — signed in', () => {
  // Fails without the change: before this slice, a confirmed Discord
  // connect landed back on `pages/Connect.tsx`, which still shows the
  // "Assistant token" field alongside a "Discord connected" status line —
  // this page must show neither.
  it('names the confirmed Discord connection and offers no "Assistant token" field', () => {
    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Discord connected' })
    ).toBeInTheDocument()
    expect(screen.getByText(/message the bot in Discord/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Assistant token')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Connect Discord' })
    ).not.toBeInTheDocument()
  })

  // The confirmation's own two onward links — fails without the change if
  // either builds the wrong address (this page's own `buildPath`, never a
  // hand-concatenated string).
  it('offers Chat and MCP links to the same organization', () => {
    const navigate = vi.fn()
    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={navigate}
      />
    )

    const chatLink = screen.getByRole('link', { name: 'Go to Chat' })
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
  it('renders the panel own chrome — the hamburger and the profile control', () => {
    render(
      <Connected
        organizationId="org-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Open navigation menu' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Account settings' })
    ).toBeInTheDocument()
  })
})
