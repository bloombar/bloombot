/**
 * WEB-2: requesting a sign-in link never stores anything — the visible
 * outcome is "check your email," not a token this component could keep.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GoogleIdentityServices } from '../src/api/google-identity.js'
import { SignIn } from '../src/pages/SignIn.js'

const { requestSignInLink, signInWithGoogle } = vi.hoisted(() => ({
  requestSignInLink: vi.fn(),
  signInWithGoogle: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, requestSignInLink, signInWithGoogle }
})

// Rework round 1 — the credential callback's own `accepted` guard is tested
// against a *fake* Google Identity Services, never the real
// `accounts.google.com` script (QA-2's own "never reached in a test"):
// `initialize` here captures the callback `pages/SignIn.tsx` registers, so a
// test can fire it directly, the same way a keyboard user reaching GIS's own
// rendered button and pressing Enter would.
const { loadGoogleIdentityServices } = vi.hoisted(() => ({
  loadGoogleIdentityServices: vi.fn(),
}))
vi.mock('../src/api/google-identity.js', () => ({ loadGoogleIdentityServices }))

function fakeGoogle(): {
  google: GoogleIdentityServices
  getCallback: () => ((response: { credential: string }) => void) | undefined
} {
  let callback: ((response: { credential: string }) => void) | undefined
  const google: GoogleIdentityServices = {
    accounts: {
      id: {
        initialize: vi.fn((config) => {
          callback = config.callback
        }),
        renderButton: vi.fn(),
        prompt: vi.fn(),
      },
    },
  }
  return { google, getCallback: () => callback }
}

// Every test besides the one that actually exercises the credential
// callback (below) leaves `loadGoogleIdentityServices` unresolved — the
// same "the script is never actually loaded in a test" (QA-2) every other
// test in this file already relies on for a `googleClientId`-configured
// render to show a slot with nothing drawn into it.
beforeEach(() => {
  loadGoogleIdentityServices.mockReturnValue(new Promise(() => {}))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SignIn (WEB-2)', () => {
  it('requests a link and shows the same message the API would rather say to any address', async () => {
    requestSignInLink.mockResolvedValue(undefined)

    render(<SignIn onSignedIn={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'student@example.edu' },
    })
    // The consent checkbox gates both sign-in paths (`pages/SignIn.tsx`);
    // without ticking it the form will not submit at all.
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    expect(await screen.findByTestId('link-requested')).toHaveTextContent(
      'student@example.edu'
    )
    // No `destination` prop supplied — the ordinary "email me a link"
    // screen, with nowhere in particular to return to.
    expect(requestSignInLink).toHaveBeenCalledWith(
      'student@example.edu',
      undefined
    )
  })

  // AUTH-6: fails without the fix — before `destination` existed, this
  // prop had nowhere to go, and a caller like `pages/JoinLink.tsx` had no
  // way to ask a redeemed sign-in to return anywhere but the ordinary shell.
  it('requests a link with the destination it was given', async () => {
    requestSignInLink.mockResolvedValue(undefined)

    render(<SignIn onSignedIn={vi.fn()} destination="/join/secret-abc" />)
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'student@example.edu' },
    })
    // The consent checkbox gates both sign-in paths (`pages/SignIn.tsx`);
    // without ticking it the form will not submit at all.
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await vi.waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'student@example.edu',
        '/join/secret-abc'
      )
    )
  })

  it('with no Google client id configured, shows no Google button', () => {
    render(<SignIn googleClientId={undefined} onSignedIn={vi.fn()} />)
    expect(
      screen.queryByRole('button', { name: 'Continue with Google' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/Google sign-in is not configured/)
    ).toBeInTheDocument()
  })

  // The bug this pins: `googleClientId` used to be a default parameter, and a
  // default fires for an explicit `undefined` as well as an omitted prop — so
  // the documented way to say "not configured" silently read
  // VITE_GOOGLE_CLIENT_ID instead. It passed for anyone whose local env did
  // not set that variable, and failed for anyone whose did, which is a test
  // whose result depends on the developer running it.
  it('treats an explicit undefined as not configured, whatever the build-time env holds', () => {
    vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'set-in-the-environment.test')
    try {
      render(<SignIn googleClientId={undefined} onSignedIn={vi.fn()} />)
      expect(
        screen.queryByRole('button', { name: 'Continue with Google' })
      ).not.toBeInTheDocument()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // Google renders its own button into this slot once its script loads, so
  // there is no button in the DOM to assert on here — the slot's presence is
  // what this app controls, and the script itself is deliberately never
  // fetched in a test (QA-2).
  it('with a Google client id configured and the documents accepted, offers Google its slot', () => {
    render(<SignIn googleClientId="test-client-id" onSignedIn={vi.fn()} />)
    fireEvent.click(screen.getByTestId('accept-legal'))

    expect(screen.getByTestId('google-button-slot')).toBeInTheDocument()
  })

  // MCP-11 — the slot is always present once Google is configured; what
  // changes with the checkbox is only whether it is disabled. Fails
  // without the fix: before this slice, the slot did not exist at all
  // until the documents were accepted (`home.test.tsx`'s own
  // "accepting the documents" describe block has the identical pair of
  // assertions, colocated with the checkbox's own coverage).
  it('the Google slot is present but aria-disabled before the checkbox is ticked, and live after', () => {
    render(<SignIn googleClientId="test-client-id" onSignedIn={vi.fn()} />)

    const slot = screen.getByTestId('google-button-slot')
    expect(slot).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(screen.getByTestId('accept-legal'))

    expect(slot).toHaveAttribute('aria-disabled', 'false')
  })

  // Rework round 1, must-fix 1 — `pointer-events-none`/`aria-disabled` alone
  // only look like a gate: a keyboard user can still tab to GIS's own
  // rendered `div[role="button"]` and press Enter, reaching this callback
  // regardless of what the slot's own attributes say. Fails without the
  // fix: the credential callback used to call `signInWithGoogle`
  // unconditionally, so this assertion caught nothing until the callback
  // gained its own `accepted` check.
  it('refuses the Google credential callback when the documents are not yet accepted', async () => {
    const { google, getCallback } = fakeGoogle()
    loadGoogleIdentityServices.mockResolvedValue(google)

    render(<SignIn googleClientId="test-client-id" onSignedIn={vi.fn()} />)

    await vi.waitFor(() => expect(getCallback()).toBeDefined())

    // The checkbox is deliberately left unticked — simulating the callback
    // firing anyway, the same as a keyboard user who reached the button
    // despite `inert`, or any other path that lands in this callback.
    getCallback()!({ credential: 'fake-id-token' })

    expect(signInWithGoogle).not.toHaveBeenCalled()
  })

  it('accepts the Google credential callback once the documents are accepted', async () => {
    const { google, getCallback } = fakeGoogle()
    loadGoogleIdentityServices.mockResolvedValue(google)
    signInWithGoogle.mockResolvedValue({ accountId: 'account-1' })

    render(<SignIn googleClientId="test-client-id" onSignedIn={vi.fn()} />)
    fireEvent.click(screen.getByTestId('accept-legal'))

    await vi.waitFor(() => expect(getCallback()).toBeDefined())

    getCallback()!({ credential: 'fake-id-token' })

    await vi.waitFor(() =>
      expect(signInWithGoogle).toHaveBeenCalledWith('fake-id-token')
    )
  })

  // MCP-11 — `headline` overrides the card's own default title;
  // `pages/ConnectAssistant.tsx` is the caller that needs this, to name the
  // client asking to connect rather than showing the generic title.
  it('overrides the default headline when one is supplied', () => {
    render(
      <SignIn
        onSignedIn={vi.fn()}
        headline="Sign in to Bloombot to connect"
        description="Some Assistant wants to connect to your Bloombot account."
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Sign in to Bloombot to connect' })
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Some Assistant wants to connect to your Bloombot account.'
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Sign in to Bloombot' })
    ).not.toBeInTheDocument()
  })
})
