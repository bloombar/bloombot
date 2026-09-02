/**
 * `pages/DiscordCallback.tsx`: completes the install with whatever
 * `components/InstallButton.tsx` stashed in `sessionStorage` plus the
 * query string Discord's own redirect carried, and reports bound or
 * refused — the same two outcomes `tests/install-button.test.tsx` proves
 * for beginning the flow (WEB-4). The LINK-7 `describe` block below proves
 * the second flow this same page now carries — a person-link connect
 * attempt, told apart by `PENDING_CONNECT_ORG_KEY` rather than
 * `PENDING_INSTALL_ORG_KEY`.
 */

import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../src/api/client.js'
import { PENDING_INSTALL_ORG_KEY } from '../src/components/InstallButton.js'
import { PENDING_CONNECT_ORG_KEY } from '../src/pages/Connect.js'
import { DiscordCallback } from '../src/pages/DiscordCallback.js'

const {
  completeDiscordInstall,
  previewDiscordPersonLink,
  confirmDiscordPersonLink,
} = vi.hoisted(() => ({
  completeDiscordInstall: vi.fn(),
  previewDiscordPersonLink: vi.fn(),
  confirmDiscordPersonLink: vi.fn(),
}))

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>(
    '../src/api/client.js'
  )
  return {
    ...actual,
    completeDiscordInstall,
    previewDiscordPersonLink,
    confirmDiscordPersonLink,
  }
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
        account={undefined}
        onInstalled={onInstalled}
        onConnected={vi.fn()}
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
        account={undefined}
        onInstalled={vi.fn()}
        onConnected={vi.fn()}
        onDone={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not found, or you do not have access to it.'
    )
  })

  it('with nothing to complete (no pending organization), offers to return rather than calling the API', () => {
    const onDone = vi.fn()
    render(
      <DiscordCallback
        search=""
        account={undefined}
        onInstalled={vi.fn()}
        onConnected={vi.fn()}
        onDone={onDone}
      />
    )
    expect(
      screen.getByText('There is nothing to complete here.')
    ).toBeInTheDocument()
    expect(completeDiscordInstall).not.toHaveBeenCalled()
  })

  // `main.tsx` renders under `StrictMode`, which mounts, cleans up and
  // re-mounts every effect once in development — a bare `render` (the tests
  // above) is not the configuration this page actually runs in. Finding 4 of
  // the WEB-1..6 rework: `completeDiscordInstall` consumes a one-use
  // install-state row, so calling it twice for the same callback meant a
  // successful install rendered as the second call's refusal.
  it('completes the install exactly once under StrictMode, even though the effect runs twice', async () => {
    sessionStorage.setItem(PENDING_INSTALL_ORG_KEY, 'org-1')
    completeDiscordInstall.mockResolvedValue({ serverId: 'guild-42' })
    const onInstalled = vi.fn()

    render(
      <StrictMode>
        <DiscordCallback
          search="?code=abc&state=xyz&guild_id=guild-42"
          account={undefined}
          onInstalled={onInstalled}
          onConnected={vi.fn()}
          onDone={vi.fn()}
        />
      </StrictMode>
    )

    await vi.waitFor(() =>
      expect(onInstalled).toHaveBeenCalledWith('org-1', 'guild-42')
    )
    expect(completeDiscordInstall).toHaveBeenCalledTimes(1)
  })
})

describe('DiscordCallback — the person-link connect branch (LINK-6/7)', () => {
  it('previews (spending the code but not the state) rather than completing on arrival — LINK-6\'s own "a visit is not consent"', async () => {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'org-1')
    previewDiscordPersonLink.mockResolvedValue({
      preview: {
        organizationId: 'org-1',
        survivorPersonId: 'person-1',
        identity: { surface: 'discord', externalId: 'snowflake-1' },
        outcome: { kind: 'attach' },
      },
      discordUsername: 'a-student',
    })

    render(
      <DiscordCallback
        search="?code=abc&state=xyz"
        account={undefined}
        onInstalled={vi.fn()}
        onConnected={vi.fn()}
        onDone={vi.fn()}
      />
    )

    expect(await screen.findByText('a-student')).toBeInTheDocument()
    expect(previewDiscordPersonLink).toHaveBeenCalledWith('org-1', {
      code: 'abc',
      state: 'xyz',
    })
    expect(confirmDiscordPersonLink).not.toHaveBeenCalled()
    // The pending marker is cleared once the code exchange has run — a
    // reload past this point must not try to re-spend an already-used code.
    expect(sessionStorage.getItem(PENDING_CONNECT_ORG_KEY)).toBeNull()
    expect(
      screen.getByText(
        'This identity has not been connected to anyone yet — connecting will attach it to your account.'
      )
    ).toBeInTheDocument()
  })

  // LINK-6's own three things a page that waits must name: the account
  // signed in, the identity being attached, and whether anything merges.
  // The case this guards against: a lab machine where account A left a
  // session open, B follows A's own invitation, authorizes with Discord as
  // themselves, and lands on a screen that used to say only "Discord
  // account: b-student — connecting will merge that record into your
  // account", with nothing saying *whose* account "your" refers to.
  it("names the account signed in ('Signed in as ...') above the confirm row", async () => {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'org-1')
    previewDiscordPersonLink.mockResolvedValue({
      preview: {
        organizationId: 'org-1',
        survivorPersonId: 'person-1',
        identity: { surface: 'discord', externalId: 'snowflake-1' },
        outcome: { kind: 'attach' },
      },
      discordUsername: 'b-student',
    })

    render(
      <DiscordCallback
        search="?code=abc&state=xyz"
        account={{
          id: 'account-a',
          email: 'account-a@example.edu',
          memberships: [],
        }}
        onInstalled={vi.fn()}
        onConnected={vi.fn()}
        onDone={vi.fn()}
      />
    )

    expect(await screen.findByText('b-student')).toBeInTheDocument()
    expect(
      screen.getByText(
        (_, node) => node?.textContent === 'Signed in as account-a@example.edu'
      )
    ).toBeInTheDocument()
  })

  it('confirms only on an explicit click, and reports the connection', async () => {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'org-1')
    previewDiscordPersonLink.mockResolvedValue({
      preview: {
        organizationId: 'org-1',
        survivorPersonId: 'person-1',
        identity: { surface: 'discord', externalId: 'snowflake-1' },
        outcome: { kind: 'attach' },
      },
    })
    confirmDiscordPersonLink.mockResolvedValue({ connected: true })
    const onConnected = vi.fn()

    render(
      <DiscordCallback
        search="?code=abc&state=xyz"
        account={undefined}
        onInstalled={vi.fn()}
        onConnected={onConnected}
        onDone={vi.fn()}
      />
    )

    const confirmButton = await screen.findByRole('button', {
      name: 'Confirm connecting',
    })
    expect(confirmDiscordPersonLink).not.toHaveBeenCalled()
    confirmButton.click()

    await vi.waitFor(() =>
      expect(confirmDiscordPersonLink).toHaveBeenCalledWith('org-1', 'xyz')
    )
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith('org-1'))
  })

  it('a merge outcome names what would be absorbed, not merely "attach"', async () => {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'org-1')
    previewDiscordPersonLink.mockResolvedValue({
      preview: {
        organizationId: 'org-1',
        survivorPersonId: 'person-1',
        identity: { surface: 'discord', externalId: 'snowflake-1' },
        outcome: { kind: 'merge', existingPersonId: 'person-2' },
      },
    })

    render(
      <DiscordCallback
        search="?code=abc&state=xyz"
        account={undefined}
        onInstalled={vi.fn()}
        onConnected={vi.fn()}
        onDone={vi.fn()}
      />
    )

    expect(
      await screen.findByText(/already belongs to a record/)
    ).toBeInTheDocument()
  })

  it('a refused preview (an unknown or expired state) renders the same refusal every other refusal in this app renders', async () => {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'org-1')
    previewDiscordPersonLink.mockRejectedValue(
      new ApiError(404, { error: 'person_link_not_found' })
    )

    render(
      <DiscordCallback
        search="?code=abc&state=xyz"
        account={undefined}
        onInstalled={vi.fn()}
        onConnected={vi.fn()}
        onDone={vi.fn()}
      />
    )

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('an install marker takes priority over a connect marker if both are somehow present', async () => {
    sessionStorage.setItem(PENDING_INSTALL_ORG_KEY, 'install-org')
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, 'connect-org')
    completeDiscordInstall.mockResolvedValue({ serverId: 'guild-42' })

    render(
      <DiscordCallback
        search="?code=abc&state=xyz&guild_id=guild-42"
        account={undefined}
        onInstalled={vi.fn()}
        onConnected={vi.fn()}
        onDone={vi.fn()}
      />
    )

    await vi.waitFor(() =>
      expect(completeDiscordInstall).toHaveBeenCalledWith('install-org', {
        code: 'abc',
        state: 'xyz',
        guildId: 'guild-42',
      })
    )
    expect(previewDiscordPersonLink).not.toHaveBeenCalled()
  })
})
