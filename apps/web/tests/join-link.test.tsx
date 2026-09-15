/**
 * `pages/JoinLink.tsx` (ENRL-8, WEB-25) — a course join link. Signed out, it
 * renders `SignIn`, passing this page's own address as `SignIn`'s
 * `destination` prop (AUTH-6) so a later sign-in redemption returns here
 * regardless of which tab redeems it (`connect.test.tsx`'s own identical
 * scenario for `pages/Connect.tsx`). Signed in, it redeems once, on mount,
 * under `StrictMode` (`redeem-link.test.tsx`'s own reasoning for why that
 * matters — a single-use secret redeemed twice would surface StrictMode's
 * second, spurious call as the response rendered), and hands the server's
 * own answer up to `onRedeemed` rather than discarding it.
 */

import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { JoinLink } from '../src/pages/JoinLink.js'

const { redeemCourseJoinLink, requestSignInLink } = vi.hoisted(() => ({
  redeemCourseJoinLink: vi.fn(),
  requestSignInLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, redeemCourseJoinLink, requestSignInLink }
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

// LINK-11 rework, must-fix 1 — a second, distinct account, reachable only
// by signing out of `ACCOUNT` and back in as this one — the probe below
// needs two identities the redemption guard could plausibly confuse.
const ACCOUNT_B: AccountSummary = {
  id: 'account-2',
  email: 'other@example.edu',
  memberships: [
    {
      organizationId: 'other-org',
      organizationName: 'Other',
      role: 'owner',
    },
  ],
  connectedOrganizations: [],
}

afterEach(() => {
  vi.resetAllMocks()
})

describe('JoinLink — signed out', () => {
  it('renders SignIn', () => {
    render(
      <JoinLink
        secret="secret-abc"
        account={null}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Sign in to Bloombot' })
    ).toBeInTheDocument()
    expect(redeemCourseJoinLink).not.toHaveBeenCalled()
  })

  // MCP-11 — this page used to render a bare `SignIn` with no header at
  // all; it now shows the same logo/name/description every sign-in surface
  // shows, exactly once. `getByRole`/`getByTestId` (not `getAllBy...`)
  // already fail on more than one match, which is what "exactly once" pins.
  it('renders the shared header exactly once', () => {
    render(
      <JoinLink
        secret="secret-abc"
        account={null}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      screen.getByRole('heading', { level: 1, name: 'Bloombot' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('bloombot-logo')).toBeInTheDocument()
  })

  // AUTH-6: fails without the fix — before `destination` existed, this
  // page's own return trip was a `sessionStorage` marker
  // (`PENDING_JOIN_LINK_KEY`), which only ever survived a sign-in
  // redemption completing in the same tab that set it.
  it('requests a sign-in link with this page as the destination', async () => {
    requestSignInLink.mockResolvedValue(undefined)

    render(
      <JoinLink
        secret="secret-abc"
        account={null}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
        navigate={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'student@example.edu' },
    })
    // The consent checkbox gates both sign-in paths (`pages/SignIn.tsx`);
    // without ticking it the form will not submit at all.
    fireEvent.click(screen.getByTestId('accept-legal'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Email me a sign-in link' })
    )

    await waitFor(() =>
      expect(requestSignInLink).toHaveBeenCalledWith(
        'student@example.edu',
        '/join/secret-abc'
      )
    )
  })
})

describe('JoinLink — signed in', () => {
  it('redeems the secret exactly once under StrictMode, and reports what the server resolved', async () => {
    redeemCourseJoinLink.mockResolvedValue({
      courseId: 'course-1',
      organizationId: 'org-1',
      alreadyEnrolled: false,
    })
    const onRedeemed = vi.fn()

    render(
      <StrictMode>
        <JoinLink
          secret="secret-abc"
          account={ACCOUNT}
          onSignedIn={vi.fn()}
          onRedeemed={onRedeemed}
          navigate={vi.fn()}
        />
      </StrictMode>
    )

    await vi.waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1))
    // The whole point under test: StrictMode's double effect invocation
    // must not spend the link twice.
    expect(redeemCourseJoinLink).toHaveBeenCalledTimes(1)
    expect(redeemCourseJoinLink).toHaveBeenCalledWith('secret-abc')
    // WEB-25: fails without the fix — before this, `onRedeemed` took no
    // arguments at all, and the course id the server already resolved was
    // simply thrown away.
    expect(onRedeemed).toHaveBeenCalledWith({
      courseId: 'course-1',
      organizationId: 'org-1',
      alreadyEnrolled: false,
    })
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
        navigate={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That join link is no longer valid. Ask for a new one.'
    )
    expect(redeemCourseJoinLink).toHaveBeenCalledTimes(1)
  })

  // LINK-11/WEB-49 — this brief "Joining…"/error render now sits inside the
  // panel's own chrome, the same as every other signed-in page.
  it('renders the panel own chrome — the hamburger and the profile control', async () => {
    redeemCourseJoinLink.mockResolvedValue({
      courseId: 'course-1',
      organizationId: 'org-1',
      alreadyEnrolled: false,
    })

    render(
      <JoinLink
        secret="secret-abc"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
        navigate={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Open navigation menu' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Account settings' })
    ).toBeInTheDocument()
  })

  // LINK-11 rework, must-fix 1 — fails without the fix: `SignedInChrome`'s
  // own sign-out control makes "sign out, sign back in as someone else,
  // same join link still open" reachable here, and the redemption guard
  // used to key on `secret` alone — unchanged across the whole sequence
  // below — so it silently skipped redeeming for the second account
  // entirely, leaving whatever `state` the first account's attempt last
  // set (an error, or a permanent "Joining…") on screen for an account that
  // never actually redeemed anything.
  it('redeems again for a different account signing in after the first signs out, with the same link still open', async () => {
    redeemCourseJoinLink.mockResolvedValue({
      courseId: 'course-1',
      organizationId: 'org-1',
      alreadyEnrolled: false,
    })

    const { rerender } = render(
      <JoinLink
        secret="secret-abc"
        account={ACCOUNT}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
        navigate={vi.fn()}
      />
    )
    await waitFor(() => expect(redeemCourseJoinLink).toHaveBeenCalledTimes(1))

    // Signed out — the same account's own sign-out control, reachable now
    // that this page carries the panel's chrome.
    rerender(
      <JoinLink
        secret="secret-abc"
        account={null}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
        navigate={vi.fn()}
      />
    )

    // A second, different account signs in — the same join link is still
    // open at the same address.
    rerender(
      <JoinLink
        secret="secret-abc"
        account={ACCOUNT_B}
        onSignedIn={vi.fn()}
        onRedeemed={vi.fn()}
        navigate={vi.fn()}
      />
    )

    await waitFor(() => expect(redeemCourseJoinLink).toHaveBeenCalledTimes(2))
  })
})
