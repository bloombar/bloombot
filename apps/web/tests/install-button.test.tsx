/**
 * WEB-4: the install button's outcomes — starting the flow (a top-level
 * navigation to the authorization URL, with the organization stashed for
 * `pages/DiscordCallback.tsx` to read back), a refusal, and "already
 * installed" with a working remove control. What actually happens once
 * Discord's own consent screen returns the browser to `/discord/callback`
 * is `tests/discord-callback.test.tsx`'s own scenario, not this one — this
 * component never sees that page.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import {
  InstallButton,
  PENDING_INSTALL_ORG_KEY,
} from '../src/components/InstallButton.js'
import { renderWithModal } from './helpers/render-with-modal.js'

const { beginDiscordInstall } = vi.hoisted(() => ({
  beginDiscordInstall: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return { ...actual, beginDiscordInstall }
})

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe('InstallButton (WEB-4)', () => {
  it('begins the install flow: stashes the organization and navigates to the authorization URL', async () => {
    beginDiscordInstall.mockResolvedValue({
      authorizationUrl: 'https://discord.test/oauth2/authorize?state=abc',
      expiresAt: Date.now() + 60_000,
    })
    // jsdom's `window.location.assign` cannot be spied on directly
    // (`Cannot redefine property`) — replace the whole `location` object,
    // same as any other DOM-navigation test in this app would need to.
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
    })

    renderWithModal(
      <InstallButton
        organizationId="org-1"
        onRemove={vi.fn()}
        removing={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Install to Discord' }))

    await waitFor(() => expect(assign).toHaveBeenCalled())
    expect(beginDiscordInstall).toHaveBeenCalledWith('org-1')
    expect(assign).toHaveBeenCalledWith(
      'https://discord.test/oauth2/authorize?state=abc'
    )
    expect(sessionStorage.getItem(PENDING_INSTALL_ORG_KEY)).toBe('org-1')
  })

  it('refused: reports the same not-found refusal every other refusal in this app renders (WEB-5)', async () => {
    beginDiscordInstall.mockRejectedValue(
      new ApiError(404, { error: 'action_refused' })
    )

    renderWithModal(
      <InstallButton
        organizationId="org-1"
        onRemove={vi.fn()}
        removing={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Install to Discord' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  it('already installed: shows the server id and offers remove, behind a confirmation (WEB-15)', async () => {
    const onRemove = vi.fn()
    renderWithModal(
      <InstallButton
        organizationId="org-1"
        installedServerId="guild-42"
        onRemove={onRemove}
        removing={false}
      />
    )
    expect(screen.getByText(/guild-42/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    // WEB-15: a destructive action confirms — clicking "Remove" alone must
    // not have called `onRemove` yet.
    expect(onRemove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove this Discord server?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(onRemove).toHaveBeenCalled())
  })
})
