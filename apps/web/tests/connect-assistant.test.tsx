/**
 * `pages/ConnectAssistant.tsx` (MCP-11) — the panel's own real page for
 * connecting an assistant, replacing `apps/api`'s former server-rendered
 * consent screen. Signed out, it renders `SignIn` headlined for this
 * connection, naming the client; signed in, it renders the consent screen
 * (client name, redirect host, Allow/Deny); either way, the API's single
 * 404 `connection_request_unavailable` renders one "try again" message.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// `vi.restoreAllMocks()` only restores spies created with `vi.spyOn` — these
// two are plain `vi.fn()`s, so their call history survives it, and
// `getConnectAssistantRequest.not.toHaveBeenCalled()` (the framed test,
// below) would otherwise be asserting against every earlier test's calls
// too. `mockReset` clears both the call history and whatever
// `mockResolvedValue`/`mockRejectedValue` a previous test left behind.
beforeEach(() => {
  getConnectAssistantRequest.mockReset()
  decideConnectAssistantRequest.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ConnectAssistant — signed out', () => {
  it('shows the sign-in surface with the connect headline and the client name', async () => {
    getConnectAssistantRequest.mockResolvedValue({
      signedIn: false,
      clientName: 'Some Assistant',
    })

    render(
      <ConnectAssistant
        requestId="req-1"
        account={null}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
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
      <ConnectAssistant
        requestId="req-1"
        account={null}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(await screen.findByText(/no registered name/i)).toBeInTheDocument()
  })

  // LINK-11 rework, must-fix 3 — fails without the fix: the session
  // expiring between `App.tsx`'s last `/auth/me` and this page's own fetch
  // leaves `account` (the client-held prop) stale-truthy while the server
  // answers `signedIn: false`. Keying the chrome on `account` alone
  // rendered the signed-in chrome — sign-out control included — around
  // this sign-in form; it must render exactly as it does for a genuinely
  // signed-out visitor.
  it('a stale-truthy account prop does not put the signed-in chrome around a server-confirmed signed-out state', async () => {
    getConnectAssistantRequest.mockResolvedValue({
      signedIn: false,
      clientName: 'Some Assistant',
    })

    render(
      <ConnectAssistant
        requestId="req-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      await screen.findByRole('heading', {
        name: 'Sign in to Bloombot to connect',
      })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open navigation menu' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Account settings' })
    ).not.toBeInTheDocument()
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
        navigate={vi.fn()}
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
        navigate={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        'https://client.example/callback?error=access_denied'
      )
    })
  })

  // LINK-11/WEB-49 — this screen's consent state now sits inside the
  // panel's own chrome, the same as every other signed-in page.
  it('renders the panel own chrome — the hamburger and the profile control', async () => {
    getConnectAssistantRequest.mockResolvedValue({
      signedIn: true,
      clientName: 'Totally Legit Assistant',
      redirectHost: 'client.example',
    })

    render(
      <ConnectAssistant
        requestId="req-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    await screen.findByText('Totally Legit Assistant')
    expect(
      screen.getByRole('button', { name: 'Open navigation menu' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Account settings' })
    ).toBeInTheDocument()
  })
})

describe('ConnectAssistant — the request is unavailable', () => {
  it('shows one "try again" message for a 404, regardless of cause', async () => {
    getConnectAssistantRequest.mockRejectedValue(
      new ApiError(404, { error: 'connection_request_unavailable' })
    )

    render(
      <ConnectAssistant
        requestId="req-1"
        account={null}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      await screen.findByTestId('connect-assistant-unavailable')
    ).toHaveTextContent(/no longer available/i)
  })

  // Rework round 1, must-fix 4 — fails without the fix: `handleDecide`
  // used to leave a 404 in `decideError`, rendered beside Allow/Deny
  // buttons that can only 404 again. Reachable whenever the request expires
  // (or is consumed by another tab) between load and this click.
  it('a 404 from POST /oauth/mcp/decide moves to the unavailable state, not a generic error beside the buttons', async () => {
    getConnectAssistantRequest.mockResolvedValue({
      signedIn: true,
      clientName: 'Some Assistant',
      redirectHost: 'client.example',
    })
    decideConnectAssistantRequest.mockRejectedValue(
      new ApiError(404, { error: 'connection_request_unavailable' })
    )

    render(
      <ConnectAssistant
        requestId="req-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))

    expect(
      await screen.findByTestId('connect-assistant-unavailable')
    ).toHaveTextContent(/no longer available/i)
  })
})

// Rework round 1, must-fix 2 — the clickjacking defence lost when this
// screen moved off `apps/api`'s own server-rendered route (framing headers
// on a JSON response protect nothing): this component must refuse to
// render consent controls, and must not even fetch the pending
// authorization, whenever it detects it is framed.
describe('ConnectAssistant — framed', () => {
  it('refuses to render consent controls, and never fetches, when embedded in another page', async () => {
    vi.stubGlobal('top', {})

    render(
      <ConnectAssistant
        requestId="req-1"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      await screen.findByTestId('connect-assistant-framed')
    ).toHaveTextContent(/open this page directly/i)
    expect(
      screen.queryByRole('button', { name: 'Allow' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Deny' })
    ).not.toBeInTheDocument()
    expect(getConnectAssistantRequest).not.toHaveBeenCalled()
  })
})
