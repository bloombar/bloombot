/**
 * `pages/Shell.tsx` (WEB-3, WEB-4): which organization the panel is acting
 * in, and that the actively selected organization — not merely whichever one
 * the component happened to mount with — is what every subsequent request
 * carries. Before this file existed there was no test at all for `Shell.tsx`
 * (finding 2 of the WEB-1..6 rework): WEB-3's central claim went untested,
 * and `tests/organization-switcher.test.tsx` explicitly defers "what active
 * means" to this component.
 */

import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import type { AccountSummary } from '../src/api/types.js'
import { Shell } from '../src/pages/Shell.js'

const { beginDiscordInstall, dispatchAction, signOut } = vi.hoisted(() => ({
  beginDiscordInstall: vi.fn(),
  dispatchAction: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, beginDiscordInstall, dispatchAction, signOut }
})

const MULTI_MEMBERSHIP_ACCOUNT: AccountSummary = {
  id: 'account-1',
  memberships: [
    { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' },
    {
      organizationId: 'org-2',
      organizationName: 'Org Two',
      role: 'assistant',
    },
  ],
}

afterEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('Shell (WEB-3, WEB-4)', () => {
  it('with no install just completed, defaults to the first membership', () => {
    render(<Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-1'
    )
  })

  it('an install that just completed for a *different* organization than the first membership opens the panel on that organization, not the first one (finding 2 of the WEB-1..6 rework)', () => {
    render(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-2', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    // The switcher shows the organization the install actually bound —
    // before this fix it stayed on org-1 (memberships[0]) while the API had
    // bound the server to org-2.
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-2'
    )
    // And the installed banner is visible on first render, not only after a
    // manual switch — `installedServerId` only matches when
    // `activeOrganizationId` equals `justInstalled.organizationId`.
    expect(screen.getByText(/guild-42/)).toBeInTheDocument()
  })

  it('a justInstalled organization the account is not actually a member of is ignored, defensively, in favour of the first membership', () => {
    render(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-9', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue(
      'org-1'
    )
  })

  it('carries the actively selected organization into every request, not the one Shell mounted with (WEB-3)', async () => {
    beginDiscordInstall.mockResolvedValue({
      authorizationUrl: 'https://discord.test/oauth2/authorize?state=abc',
      expiresAt: Date.now() + 60_000,
    })
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    })

    render(<Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={vi.fn()} />)

    // Switch away from the organization this mounted with...
    fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), {
      target: { value: 'org-2' },
    })
    // ...and begin an install. If Shell carried the *initial* organization
    // into this request instead of the actively selected one, this would
    // call beginDiscordInstall with 'org-1' — exactly the class of bug
    // WEB-3 exists to rule out ("cannot act in one while believing they are
    // in the other").
    fireEvent.click(screen.getByRole('button', { name: 'Install to Discord' }))

    await vi.waitFor(() =>
      expect(beginDiscordInstall).toHaveBeenCalledWith('org-2')
    )
  })

  it('removing an installed server dispatches against the actively selected organization', async () => {
    dispatchAction.mockResolvedValue({ result: undefined })

    render(
      <Shell
        account={MULTI_MEMBERSHIP_ACCOUNT}
        justInstalled={{ organizationId: 'org-2', serverId: 'guild-42' }}
        onSignedOut={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await vi.waitFor(() =>
      expect(dispatchAction).toHaveBeenCalledWith(
        'org-2',
        'discordServers.remove',
        { serverId: 'guild-42' }
      )
    )
    // The banner clears once the remove succeeds.
    expect(
      await screen.findByRole('button', { name: 'Install to Discord' })
    ).toBeInTheDocument()
  })

  it('a sign-out that fails to round-trip still signs the caller out of this screen, without an unhandled rejection', async () => {
    signOut.mockRejectedValue(new ApiError(0, { error: 'network_error' }))
    const onSignedOut = vi.fn()

    render(
      <Shell account={MULTI_MEMBERSHIP_ACCOUNT} onSignedOut={onSignedOut} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    // If `handleSignOut`'s `try/finally` had no `catch` (finding 3 of the
    // WEB-1..6 rework), the rejection from `signOut()` would propagate past
    // `finally` with nowhere to land — Vitest reports that as a test
    // failure in its own right, on top of this assertion.
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1))
  })
})
