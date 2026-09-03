/**
 * `pages/Invitation.tsx` (ENRL-10, AUTH-6) — a membership invitation. Signed
 * out, it renders `SignIn`, passing this page's own address as `SignIn`'s
 * `destination` prop (AUTH-6) so a later sign-in redemption returns here
 * regardless of which tab redeems it (`join-link.test.tsx`'s own identical
 * scenario for `pages/JoinLink.tsx`, this page's own precedent). Signed in,
 * it redeems once, on mount, under `StrictMode`.
 *
 * Rework, found in review: this used to stash a `PENDING_INVITATION_KEY`
 * `sessionStorage` marker instead — the exact same-tab-only device AUTH-6
 * retired everywhere else, which this page had kept. The two tests that
 * covered that marker (stashing it signed out, clearing a stale one signed
 * in) are gone with it; `'requests a sign-in link with this page as the
 * destination'`, below, is `join-link.test.tsx`'s own cross-tab-safe
 * replacement.
 */

import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Invitation } from '../src/pages/Invitation.js'

const { redeemMembershipInvitation, requestSignInLink } = vi.hoisted(() => ({
  redeemMembershipInvitation: vi.fn(),
  requestSignInLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, redeemMembershipInvitation, requestSignInLink }
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
})

describe('Invitation — signed out', () => {
  it('renders SignIn', () => {
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
    expect(redeemMembershipInvitation).not.toHaveBeenCalled()
  })

  // AUTH-6, rework — fails without the fix: before `destination` was passed
  // through here, this page's own return trip was a `sessionStorage` marker
  // (`PENDING_INVITATION_KEY`), which only ever survived a sign-in
  // redemption completing in the same tab that set it — an owner's invited
  // colleague opening the invitation email in a fresh tab landed on the
  // plain shell with no membership. `join-link.test.tsx`'s own identical
  // case is this test's precedent.
  it('requests a sign-in link with this page as the destination', async () => {
    requestSignInLink.mockResolvedValue(undefined)

    render(
      <Invitation
        secret="secret-abc"
        account={null}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'colleague@example.edu' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'colleague@example.edu',
        '/invitations/secret-abc'
      )
    )
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
