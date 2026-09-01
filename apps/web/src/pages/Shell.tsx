/**
 * The signed-in shell: which organization the panel is acting in (WEB-3)
 * and the Discord install button (WEB-4). Projects and courses are phase 7
 * (out of this slice's scope) — this is deliberately just the shell.
 */

import { useState } from 'react'

import { ApiError, dispatchAction, signOut } from '../api/client.js'
import type { AccountSummary } from '../api/types.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { InstallButton } from '../components/InstallButton.js'
import { OrganizationSwitcher } from '../components/OrganizationSwitcher.js'

export interface ShellProps {
  account: AccountSummary
  /** Set by `App.tsx` once `pages/DiscordCallback.tsx` reports a bound server — carries across the round trip through Discord's own consent screen (see that page's module comment). `undefined` until an install completes in this browser session; there is no route today to look up an organization's existing bindings (see `docs/DECISIONS.md`). */
  justInstalled?: { organizationId: string; serverId: string }
  onSignedOut: () => void
}

export function Shell({ account, justInstalled, onSignedOut }: ShellProps) {
  const [activeOrganizationId, setActiveOrganizationId] = useState(
    account.memberships[0]?.organizationId ?? ''
  )
  const [removedServerId, setRemovedServerId] = useState<string | undefined>(
    undefined
  )
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [signingOut, setSigningOut] = useState(false)

  const installedServerId =
    justInstalled?.organizationId === activeOrganizationId &&
    justInstalled.serverId !== removedServerId
      ? justInstalled.serverId
      : undefined

  const handleRemove = async () => {
    if (!installedServerId) return
    setError(undefined)
    setRemoving(true)
    try {
      // TEN-6 — an ordinary action, reached the same way any other action
      // in `@bloombot/actions`' catalog is (`api/client.ts#dispatchAction`'s
      // own comment on why this is not a bespoke route).
      await dispatchAction(activeOrganizationId, 'discordServers.remove', {
        serverId: installedServerId,
      })
      setRemovedServerId(installedServerId)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setRemoving(false)
    }
  }

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      // AUTH-3: sign-out revokes the session server-side even if this
      // request somehow fails to round-trip — the caller should not be
      // stuck signed in on this screen either way, so `onSignedOut` runs
      // regardless and `App.tsx`'s own `/auth/me` re-check is the source of
      // truth for whether the session actually ended.
      setSigningOut(false)
      onSignedOut()
    }
  }

  return (
    <div className="shell">
      <header>
        <OrganizationSwitcher
          memberships={account.memberships}
          activeOrganizationId={activeOrganizationId}
          onChange={setActiveOrganizationId}
        />
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>
      <main>
        <InstallButton
          organizationId={activeOrganizationId}
          {...(installedServerId ? { installedServerId } : {})}
          onRemove={() => void handleRemove()}
          removing={removing}
        />
        {error && <ErrorMessage error={error} />}
      </main>
    </div>
  )
}
