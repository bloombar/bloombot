/**
 * WEB-2: requesting a sign-in link never stores anything — the visible
 * outcome is "check your email," not a token this component could keep.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SignIn } from '../src/pages/SignIn.js'

const { requestSignInLink } = vi.hoisted(() => ({
  requestSignInLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, requestSignInLink }
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

  it('with a Google client id configured, shows the Google button', () => {
    render(<SignIn googleClientId="test-client-id" onSignedIn={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: 'Continue with Google' })
    ).toBeInTheDocument()
  })
})
