/**
 * `pages/RedeemLink.tsx` (AUTH-1, WEB-2): redeems the single-use token in
 * the URL and reports what happened. Rendered under `StrictMode` here
 * (`tests/setup.ts` does not do this itself — `main.tsx` is the one place
 * that decides that) rather than a bare `render`, since a bare render is
 * not the configuration this page actually runs in and would not have
 * caught finding 4 of the WEB-1..6 rework: `StrictMode`'s own
 * mount/cleanup/remount of every effect once meant a *successful* redemption
 * called `redeemSignInLink` twice, and the second call — always a 401,
 * since the token is single-use — was the one whose response the surviving
 * instance rendered.
 */

import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { RedeemLink } from '../src/pages/RedeemLink.js'

const { redeemSignInLink, requestSignInLink } = vi.hoisted(() => ({
  redeemSignInLink: vi.fn(),
  requestSignInLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, redeemSignInLink, requestSignInLink }
})

afterEach(() => {
  vi.resetAllMocks()
  // MCP-12 — several tests below set the URL's own query string
  // (`window.history.pushState`, since `RedeemLink` reads
  // `window.location.search` directly); reset it so an earlier test's
  // `?destination=...` never leaks into a later one that renders no route
  // at all.
  window.history.pushState({}, '', '/')
})

describe('RedeemLink (AUTH-1, WEB-2)', () => {
  it('redeems the token exactly once under StrictMode, and reports success', async () => {
    redeemSignInLink.mockResolvedValue({ accountId: 'account-1' })
    const onRedeemed = vi.fn()

    render(
      <StrictMode>
        <RedeemLink token="tok-abc" onRedeemed={onRedeemed} />
      </StrictMode>
    )

    await vi.waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1))
    // The whole point under test: StrictMode's double effect invocation
    // must not spend the single-use token twice.
    expect(redeemSignInLink).toHaveBeenCalledTimes(1)
    expect(redeemSignInLink).toHaveBeenCalledWith('tok-abc')
    // No `destination` in the response — an ordinary sign-in with nowhere
    // in particular to return to.
    expect(onRedeemed).toHaveBeenCalledWith(undefined)
  })

  // AUTH-6: fails without the fix — before `onRedeemed` was threaded the
  // token's own `destination` through, this page discarded it the same way
  // `JoinLink.tsx` discarded `redeemCourseJoinLink`'s own result (WEB-25).
  it('passes the redeemed destination through to onRedeemed', async () => {
    redeemSignInLink.mockResolvedValue({
      accountId: 'account-1',
      destination: '/join/abc123',
    })
    const onRedeemed = vi.fn()

    render(<RedeemLink token="tok-abc" onRedeemed={onRedeemed} />)

    await vi.waitFor(() =>
      expect(onRedeemed).toHaveBeenCalledWith('/join/abc123')
    )
  })

  // MCP-12 — the failure state is a page of this app like any other
  // (SignInHeader, the panel's own layout), not a bare error box, and a new
  // link can be requested without leaving it.
  it('a genuinely invalid token still reports the refusal, once, under StrictMode — with the branded header and a way to request a new link', async () => {
    redeemSignInLink.mockRejectedValue(
      new ApiError(401, { error: 'invalid_token' })
    )

    render(
      <StrictMode>
        <RedeemLink token="tok-bad" onRedeemed={vi.fn()} />
      </StrictMode>
    )

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bloombot' })
    ).toBeInTheDocument()
    expect(screen.getByText(/no longer works/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    ).toBeInTheDocument()
    expect(redeemSignInLink).toHaveBeenCalledTimes(1)
  })

  // MCP-12 — fails without the fix: before `buildSignInLink` carried
  // `destination` as a query parameter, this page had no way to recover it
  // once the token that carried it had already expired, so a retry request
  // from here always landed on the ordinary shell rather than back where
  // the person actually started.
  it('carries a `?destination=` hint from the URL through to the retried request', async () => {
    window.history.pushState(
      {},
      '',
      '/sign-in/tok-bad?destination=%2Fconnect-assistant%2Freq-1'
    )
    redeemSignInLink.mockRejectedValue(
      new ApiError(401, { error: 'invalid_token' })
    )
    requestSignInLink.mockResolvedValue(undefined)

    render(<RedeemLink token="tok-bad" onRedeemed={vi.fn()} />)

    fireEvent.click(await screen.findByTestId('accept-legal'))
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'student@example.edu' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await vi.waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'student@example.edu',
        '/connect-assistant/req-1'
      )
    )
  })

  // A malicious or malformed `?destination=` must not reach `SignIn` at
  // all — the same `isSameOriginPath` gate the server itself re-checks
  // before ever trusting a destination (`routes/auth.ts`).
  it('drops a `?destination=` hint that is not a same-origin path', async () => {
    window.history.pushState(
      {},
      '',
      '/sign-in/tok-bad?destination=https%3A%2F%2Fattacker.example'
    )
    redeemSignInLink.mockRejectedValue(
      new ApiError(401, { error: 'invalid_token' })
    )
    requestSignInLink.mockResolvedValue(undefined)

    render(<RedeemLink token="tok-bad" onRedeemed={vi.fn()} />)

    fireEvent.click(await screen.findByTestId('accept-legal'))
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'student@example.edu' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await vi.waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'student@example.edu',
        undefined
      )
    )
  })
})
