/**
 * WEB-4: one button that installs the bot into a Discord server.
 *
 * Clicking it begins the platform's own OAuth+PKCE flow
 * (`beginDiscordInstall`) and navigates the whole browser to Discord's
 * authorization URL — a top-level navigation, not a popup, so it survives
 * the way `apps/api`'s own `SameSite=Lax` session cookie is documented to
 * (D-20). `organizationId` is stashed in `sessionStorage` first: Discord's
 * redirect back to `/discord/callback` (`pages/DiscordCallback.tsx`) is a
 * fresh page load with no component state left, and the callback route
 * needs to know which organization the install was for — not a token, not
 * anything secret, just the id this same account is already a member of
 * (WEB-2's "nothing in the bundle stores a token" is about credentials,
 * not this).
 *
 * `outcome`/`installedServerId` come from the parent (`pages/Shell.tsx`),
 * which is what actually reads the callback's result once the browser
 * returns — this component only renders whatever state it is handed, per
 * WEB-4's "already installed shows as installed, with the option to
 * remove."
 */

import { useState } from 'react'

import { beginDiscordInstall } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { ErrorMessage } from './ErrorMessage.js'

export const PENDING_INSTALL_ORG_KEY = 'bloombot:pendingInstallOrganizationId'

export interface InstallButtonProps {
  organizationId: string
  /** Set once `pages/DiscordCallback.tsx` has reported a bound server for this organization — `undefined` when nothing has been installed this session (see the module comment on why this app cannot know about an earlier session's install). */
  installedServerId?: string
  onRemove: () => void
  removing: boolean
}

export function InstallButton({
  organizationId,
  installedServerId,
  onRemove,
  removing,
}: InstallButtonProps) {
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [starting, setStarting] = useState(false)

  if (installedServerId) {
    return (
      <div className="install-button" data-testid="install-button">
        <p>Installed — server {installedServerId}</p>
        <button type="button" onClick={onRemove} disabled={removing}>
          {removing ? 'Removing…' : 'Remove'}
        </button>
      </div>
    )
  }

  const handleClick = async () => {
    setError(undefined)
    setStarting(true)
    try {
      const begun = await beginDiscordInstall(organizationId)
      sessionStorage.setItem(PENDING_INSTALL_ORG_KEY, organizationId)
      window.location.assign(begun.authorizationUrl)
    } catch (caught) {
      setStarting(false)
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    }
  }

  return (
    <div className="install-button" data-testid="install-button">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={starting}
      >
        {starting ? 'Starting…' : 'Install to Discord'}
      </button>
      {error && <ErrorMessage error={error} />}
    </div>
  )
}
