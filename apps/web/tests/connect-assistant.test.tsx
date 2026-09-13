/**
 * `pages/ConnectAssistant.tsx` (MCP-11) — the panel's own real page for
 * connecting an assistant, replacing `apps/api`'s former server-rendered
 * consent screen. Signed out, it renders `SignIn` headlined for this
 * connection, naming the client; signed in, it renders the consent screen
 * (client name, redirect host, Allow/Deny); either way, the API's single
 * 404 `connection_request_unavailable` renders one "try again" message.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { ConnectAssistant } from '../src/pages/ConnectAssistant.js'

const { getConnectAssistantRequest, decideConnectAssistantRequest } =
  vi.hoisted(() => ({
    getConnectAssistantRequest: vi.fn(),
    decideConnectAssistantRequest: vi.fn(),
  }))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    getConnectAssistantRequest,
    decideConnectAssistantRequest,
  }
})

const ACCOUNT: AccountSummary = {
  id: 'account-1',
  email: 'instructor@example.edu',
  memberships: [],
  connectedOrganizations: [],
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConnectAssistant — signed out', () => {
  it('shows the sign-in surface with the connect headline and the client name', async () => {
    getConnectAssistantRequest.mockResolvedValue({
      signedIn: false,
      clientName: 'Some Assistant',
    })

    render(
      <ConnectAssistant requestId="req-1" account={null} onSignedIn={vi.fn()} />
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Sign in to Bloombot to connect',
      })
    ).toBeInTheDocument()
    expect(screen.getByText(/Some Assistant/)).toBeInTheDocument()
    // The shared header still renders — every sign-in surface shows it.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Bloombot' })
    ).toBeInTheDocument()
  })

  it('names the client honestly when it registered none', async () => {
    getConnectAssistantRequest.mockResolvedValue({ signedIn: false })

    render(
      <ConnectAssistant requestId="req-1" account={null} onSignedIn={vi.fn()} />
    )

    expect(await screen.findByText(/no registered name/i)).toBeInTheDocument()
  })
})

describe('ConnectAssistant — signed in', () => {
  it('names the client and the redirect host, and allow navigates to redirectTo', async () => {
    getConnectAssistantRequest.mockResolvedValue({
      signedIn: true,
      clientName: 'Totally Legit Assistant',
      redirectHost: 'client.example',
    })
    decideConnectAssistantRequest.mockResolvedValue({
      redirectTo: 'https://client.example/callback?code=abc',
    })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })

    render(
      <ConnectAssistant
        requestId="req-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
      />
    )

    expect(
      await screen.findByText('Totally Legit Assistant')
    ).toBeInTheDocument()
    expect(screen.getByText('client.example')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))

    await waitFor(() => {
      expect(decideConnectAssistantRequest).toHaveBeenCalledWith(
        'req-1',
        'allow'
      )
    })
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        'https://client.example/callback?code=abc'
      )
    })
  })

  it('deny also navigates to whatever redirectTo the API answers', async () => {
    getConnectAssistantRequest.mockResolvedValue({
      signedIn: true,
      redirectHost: 'client.example',
    })
    decideConnectAssistantRequest.mockResolvedValue({
      redirectTo: 'https://client.example/callback?error=access_denied',
    })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })

    render(
      <ConnectAssistant
        requestId="req-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        'https://client.example/callback?error=access_denied'
      )
    })
  })
})

describe('ConnectAssistant — the request is unavailable', () => {
  it('shows one "try again" message for a 404, regardless of cause', async () => {
    getConnectAssistantRequest.mockRejectedValue(
      new ApiError(404, { error: 'connection_request_unavailable' })
    )

    render(
      <ConnectAssistant requestId="req-1" account={null} onSignedIn={vi.fn()} />
    )

    expect(
      await screen.findByTestId('connect-assistant-unavailable')
    ).toHaveTextContent(/no longer available/i)
  })
})
