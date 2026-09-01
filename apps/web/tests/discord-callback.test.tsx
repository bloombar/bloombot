/**
 * `pages/DiscordCallback.tsx` (WEB-4): completes the install with whatever
 * `components/InstallButton.tsx` stashed in `sessionStorage` plus the
 * query string Discord's own redirect carried, and reports bound or
 * refused — the same two outcomes `tests/install-button.test.tsx` proves
 * for beginning the flow.
 */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { PENDING_INSTALL_ORG_KEY } from '../src/components/InstallButton.js'
import { DiscordCallback } from '../src/pages/DiscordCallback.js'

const { completeDiscordInstall } = vi.hoisted(() => ({
  completeDiscordInstall: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, completeDiscordInstall }
})

afterEach(() => {
  // `completeDiscordInstall` is a plain `vi.fn()`, not a spy — `resetAllMocks`
  // (not merely `restoreAllMocks`) is what clears its call history and
  // implementation between tests.
  vi.resetAllMocks()
  sessionStorage.clear()
})

describe('DiscordCallback (WEB-4)', () => {
  it('bound: completes with the stashed organization and the redirect query, then reports it', async () => {
    sessionStorage.setItem(PENDING_INSTALL_ORG_KEY, 'org-1')
    completeDiscordInstall.mockResolvedValue({ serverId: 'guild-42' })
    const onInstalled = vi.fn()

    render(
      <DiscordCallback
        search="?code=abc&state=xyz&guild_id=guild-42"
        onInstalled={onInstalled}
        onDone={vi.fn()}
      />
    )

    await vi.waitFor(() =>
      expect(onInstalled).toHaveBeenCalledWith('org-1', 'guild-42')
    )
    expect(completeDiscordInstall).toHaveBeenCalledWith('org-1', {
      code: 'abc',
      state: 'xyz',
      guildId: 'guild-42',
    })
    // The pending marker is cleared either way — nothing left for a later,
    // unrelated visit to this page to pick up by accident.
    expect(sessionStorage.getItem(PENDING_INSTALL_ORG_KEY)).toBeNull()
  })

  it('refused: renders the same not-found message every refusal in this app renders (WEB-5)', async () => {
    sessionStorage.setItem(PENDING_INSTALL_ORG_KEY, 'org-1')
    completeDiscordInstall.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    render(
      <DiscordCallback
        search="?code=abc&state=xyz&guild_id=guild-42"
        onInstalled={vi.fn()}
        onDone={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  it('with nothing to complete (no pending organization), offers to return rather than calling the API', () => {
    const onDone = vi.fn()
    render(<DiscordCallback search="" onInstalled={vi.fn()} onDone={onDone} />)
    expect(
      screen.getByText('There is nothing to complete here.')
    ).toBeInTheDocument()
    expect(completeDiscordInstall).not.toHaveBeenCalled()
  })
})
