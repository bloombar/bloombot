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
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    expect(await screen.findByTestId('link-requested')).toHaveTextContent(
      'student@example.edu'
    )
    expect(requestSignInLink).toHaveBeenCalledWith('student@example.edu')
  })

  it('with no Google client id configured, shows no Google button', () => {
    render(<SignIn googleClientId={undefined} onSignedIn={vi.fn()} />)
    expect(
      screen.queryByRole('button', { name: 'Sign in with Google' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/Google sign-in is not configured/)
    ).toBeInTheDocument()
  })

  it('with a Google client id configured, shows the Google button', () => {
    render(<SignIn googleClientId="test-client-id" onSignedIn={vi.fn()} />)
    expect(
      screen.getByRole('button', { name: 'Sign in with Google' })
    ).toBeInTheDocument()
  })
})
