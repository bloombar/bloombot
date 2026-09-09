/**
 * The signed-out home page, the consent gate, and the legal links that must
 * appear on every page.
 *
 * These assertions exist because of an external reviewer, not an internal
 * one: Google's OAuth verification checks that the homepage identifies the
 * app, describes what it does, and links the privacy policy — and that a
 * homepage is not merely a login screen. Each of those is a property of the
 * rendered page, so each is asserted as one. A future refactor that
 * simplifies the home page back into a bare sign-in form would pass every
 * other test in this suite and fail verification silently weeks later.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { App } from '../src/App.js'
import { Home } from '../src/pages/Home.js'
import { SignIn } from '../src/pages/SignIn.js'

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    fetchMe: vi.fn().mockResolvedValue({ account: null }),
    requestSignInLink: vi.fn().mockResolvedValue(undefined),
  }
})

describe('the signed-out home page (Google OAuth homepage requirements)', () => {
  it('renders at / for a signed-out visitor, instead of a bare sign-in form', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
  })

  it('identifies the app by name and mark', () => {
    render(<Home onSignedIn={vi.fn()} />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Bloombot' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('bloombot-logo')).toBeInTheDocument()
  })

  it('describes what the app does, not only how to sign in', () => {
    render(<Home onSignedIn={vi.fn()} />)

    expect(
      screen.getByRole('heading', { level: 2, name: 'What it does' })
    ).toBeInTheDocument()
    // The description has to survive a rewrite of the marketing copy, so this
    // asserts the subject matter rather than a sentence: a homepage that no
    // longer mentions what it answers or where is not describing the app.
    const main = screen.getByRole('main')
    expect(main).toHaveTextContent(/course questions/i)
    expect(main).toHaveTextContent(/Discord/)
  })

  it('links the privacy policy from the homepage, at /privacy', () => {
    render(<Home onSignedIn={vi.fn()} />)

    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === '/privacy')
    expect(links.length).toBeGreaterThan(0)
  })

  it('summarises privacy without softening what it says', () => {
    render(<Home onSignedIn={vi.fn()} />)

    const summary = screen.getByRole('region', { name: 'Privacy, in short' })
    // The three disclosures a reader would most want before signing in, and
    // the three most likely to be quietly dropped in a later copy edit.
    expect(summary).toHaveTextContent(
      /instructor can read their own students’ conversations/i
    )
    expect(summary).toHaveTextContent(/sent to an AI provider/i)
    expect(summary).toHaveTextContent(/cannot yet delete/i)
  })

  it('discloses what Google data is used, which the review asks for explicitly', () => {
    render(<Home onSignedIn={vi.fn()} />)

    const summary = screen.getByRole('region', { name: 'Privacy, in short' })
    expect(summary).toHaveTextContent(
      /email address, name and profile picture/i
    )
    expect(summary).toHaveTextContent(/request no other Google data/i)
  })

  it('still offers sign-in, below the description', () => {
    render(<Home onSignedIn={vi.fn()} />)

    expect(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    ).toBeInTheDocument()
  })

  it('carries the legal footer', () => {
    render(<Home onSignedIn={vi.fn()} />)

    const footer = screen.getByTestId('site-footer')
    expect(
      within(footer).getByRole('link', { name: 'Privacy policy' })
    ).toHaveAttribute('href', '/privacy')
    expect(
      within(footer).getByRole('link', { name: 'Terms & conditions' })
    ).toHaveAttribute('href', '/terms')
  })
})

describe('accepting the documents before an account exists', () => {
  it('starts unchecked, and requires the checkbox', () => {
    render(<SignIn onSignedIn={vi.fn()} />)

    const checkbox = screen.getByTestId('accept-legal')
    expect(checkbox).not.toBeChecked()
    // `required` is what stops the form submitting at all, so the request is
    // never made rather than made and rejected.
    expect(checkbox).toBeRequired()
  })

  it('links both documents from the consent line itself', () => {
    render(<SignIn onSignedIn={vi.fn()} />)

    const consent = screen.getByTestId('accept-legal').closest('label')
    expect(consent).not.toBeNull()
    expect(
      within(consent!).getByRole('link', { name: 'privacy policy' })
    ).toHaveAttribute('href', '/privacy')
    expect(
      within(consent!).getByRole('link', { name: 'terms & conditions' })
    ).toHaveAttribute('href', '/terms')
  })

  it('gates the Google button too, not only the email form', () => {
    // The Google path never touches the form, so `required` does not cover it
    // — without an explicit gate it would create an account for someone who
    // agreed to nothing.
    render(<SignIn onSignedIn={vi.fn()} googleClientId="client-id.test" />)

    expect(
      screen.getByRole('button', { name: 'Continue with Google' })
    ).toBeDisabled()
  })

  it('enables the Google button once the documents are accepted', () => {
    render(<SignIn onSignedIn={vi.fn()} googleClientId="client-id.test" />)

    fireEvent.click(screen.getByTestId('accept-legal'))

    expect(
      screen.getByRole('button', { name: 'Continue with Google' })
    ).toBeEnabled()
  })
})
