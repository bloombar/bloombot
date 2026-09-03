/**
 * `pages/Invitation.tsx` (ENRL-10) — a membership invitation. Signed out, it
 * renders `SignIn` and stashes the secret for `App.tsx`'s own
 * `returnToShell` to pick back up (`join-link.test.tsx`'s own identical
 * scenario for `PENDING_JOIN_LINK_KEY`). Signed in, it redeems once, on
 * mount, under `StrictMode`.
 */

import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Invitation, PENDING_INVITATION_KEY } from '../src/pages/Invitation.js'

const { redeemMembershipInvitation } = vi.hoisted(() => ({
  redeemMembershipInvitation: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, redeemMembershipInvitation }
})

const ACCOUNT: AccountSummary = {
  id: 'account-1',
  email: 'colleague@example.edu',
  memberships: [
    {
      organizationId: 'personal-org',
      organizationName: 'Colleague',
      role: 'owner',
    },
  ],
  connectedOrganizations: [],
}

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('Invitation — signed out', () => {
  it('renders SignIn, and stashes the secret for a later sign-in redemption to pick back up', () => {
    render(
      <Invitation
        secret="secret-abc"
        account={null}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBe('secret-abc')
    expect(redeemMembershipInvitation).not.toHaveBeenCalled()
  })
})

describe('Invitation — signed in', () => {
  it('redeems the secret exactly once under StrictMode, and reports success', async () => {
    redeemMembershipInvitation.mockResolvedValue({
      organizationId: 'org-1',
      role: 'instructor',
    })
    const onRedeemed = vi.fn()

    render(
      <StrictMode>
        <Invitation
          secret="secret-abc"
          account={ACCOUNT}
          onSignedIn={vi.fn()}
          onRedeemed={onRedeemed}
        />
      </StrictMode>
    )

    await vi.waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1))
    // The whole point under test: StrictMode's double effect invocation
    // must not spend the invitation twice.
    expect(redeemMembershipInvitation).toHaveBeenCalledTimes(1)
    expect(redeemMembershipInvitation).toHaveBeenCalledWith('secret-abc')
  })

  it('clears a stale pending marker once signed in', async () => {
    sessionStorage.setItem(PENDING_INVITATION_KEY, 'some-other-secret')
    redeemMembershipInvitation.mockResolvedValue({
      organizationId: 'org-1',
      role: 'instructor',
    })

    render(
      <Invitation
        secret="secret-abc"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
      />
    )

    await vi.waitFor(() =>
      expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
    )
  })

  // ENRL-10: a refused redemption (never issued, revoked, expired,
  // already-redeemed, wrong-account or already-a-member — indistinguishable,
  // this app's own `describeApiError`) renders the same plain refusal every
  // other refusal in this app renders.
  it('a refused redemption renders the same not-found-shaped message', async () => {
    redeemMembershipInvitation.mockRejectedValue(
      new ApiError(404, { error: 'membership_invitation_not_found' })
    )

    render(
      <Invitation
        secret="secret-bad"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That invitation is no longer valid. Ask for a new one.'
    )
    expect(redeemMembershipInvitation).toHaveBeenCalledTimes(1)
  })
})
