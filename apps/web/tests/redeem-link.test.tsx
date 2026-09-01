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
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { RedeemLink } from '../src/pages/RedeemLink.js'

const { redeemSignInLink } = vi.hoisted(() => ({
  redeemSignInLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, redeemSignInLink }
})

afterEach(() => {
  vi.resetAllMocks()
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
  })

  it('a genuinely invalid token still reports the refusal, once, under StrictMode', async () => {
    redeemSignInLink.mockRejectedValue(
      new ApiError(401, { error: 'invalid_token' })
    )

    render(
      <StrictMode>
        <RedeemLink token="tok-bad" onRedeemed={vi.fn()} />
      </StrictMode>
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That link is no longer valid. Request a new one.'
    )
    expect(redeemSignInLink).toHaveBeenCalledTimes(1)
  })
})
