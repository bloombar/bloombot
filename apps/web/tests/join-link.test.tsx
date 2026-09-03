/**
 * `pages/JoinLink.tsx` (ENRL-8) — a course join link. Signed out, it
 * renders `SignIn` and stashes the secret for `App.tsx`'s own
 * `returnToShell` to pick back up (`connect.test.tsx`'s own identical
 * scenario for `PENDING_CONNECT_ORG_KEY`). Signed in, it redeems once, on
 * mount, under `StrictMode` (`redeem-link.test.tsx`'s own reasoning for why
 * that matters — a single-use secret redeemed twice would surface
 * StrictMode's second, spurious call as the response rendered).
 */

import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { JoinLink, PENDING_JOIN_LINK_KEY } from '../src/pages/JoinLink.js'

const { redeemCourseJoinLink } = vi.hoisted(() => ({
  redeemCourseJoinLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, redeemCourseJoinLink }
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
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('JoinLink — signed out', () => {
  it('renders SignIn, and stashes the secret for a later sign-in redemption to pick back up', () => {
    render(
      <JoinLink
        secret="secret-abc"
        account={null}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
    expect(sessionStorage.getItem(PENDING_JOIN_LINK_KEY)).toBe('secret-abc')
    expect(redeemCourseJoinLink).not.toHaveBeenCalled()
  })
})

describe('JoinLink — signed in', () => {
  it('redeems the secret exactly once under StrictMode, and reports success', async () => {
    redeemCourseJoinLink.mockResolvedValue({ courseId: 'course-1' })
    const onRedeemed = vi.fn()

    render(
      <StrictMode>
        <JoinLink
          secret="secret-abc"
          account={ACCOUNT}
          onSignedIn={vi.fn()}
          onRedeemed={onRedeemed}
        />
      </StrictMode>
    )

    await vi.waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1))
    // The whole point under test: StrictMode's double effect invocation
    // must not spend the link twice.
    expect(redeemCourseJoinLink).toHaveBeenCalledTimes(1)
    expect(redeemCourseJoinLink).toHaveBeenCalledWith('secret-abc')
  })

  it('clears a stale pending marker once signed in', async () => {
    sessionStorage.setItem(PENDING_JOIN_LINK_KEY, 'some-other-secret')
    redeemCourseJoinLink.mockResolvedValue({ courseId: 'course-1' })

    render(
      <JoinLink
        secret="secret-abc"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
      />
    )

    await vi.waitFor(() =>
      expect(sessionStorage.getItem(PENDING_JOIN_LINK_KEY)).toBeNull()
    )
  })

  // ENRL-4/ENRL-8: a refused redemption (never issued, revoked or expired —
  // indistinguishable, this app's own `describeApiError`) renders the same
  // plain refusal every other refusal in this app renders, not a stack
  // trace or a raw status code.
  it('a refused redemption renders the same not-found-shaped message', async () => {
    redeemCourseJoinLink.mockRejectedValue(
      new ApiError(404, { error: 'join_link_not_found' })
    )

    render(
      <JoinLink
        secret="secret-bad"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That join link is no longer valid. Ask for a new one.'
    )
    expect(redeemCourseJoinLink).toHaveBeenCalledTimes(1)
  })
})
