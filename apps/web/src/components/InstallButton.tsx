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
 * `installedServerId` comes from the parent (`pages/Shell.tsx`), which
 * resolves it two ways: the immediate, same-session signal once the
 * browser returns from the callback, and — since TEN-8's own read of
 * `discordServers.list` closed the gap this comment used to describe —
 * `apps/web/src/api/client.ts#listDiscordServers`, a lookup against
 * whatever is actually bound server-side, which is what makes a reload or
 * a second device show the truth rather than only what this browser
 * session happened to install. This component only renders whatever state
 * it is handed, per WEB-4's "already installed shows as installed, with
 * the option to remove."
 */

import { useState } from 'react'

import { beginDiscordInstall } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { DeleteIcon } from '../icons.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { useModal } from './modal/ModalProvider.js'

export const PENDING_INSTALL_ORG_KEY = 'bloombot:pendingInstallOrganizationId'

export interface InstallButtonProps {
  organizationId: string
  /** The active binding's server id for this organization, or `undefined` when none is bound. Set either by `pages/DiscordCallback.tsx`'s same-session signal or by `pages/Shell.tsx`'s own `listDiscordServers` lookup (TEN-8) — see the module comment above for how the parent resolves the two. */
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
  const { confirm } = useModal()

  // WEB-15: removing the bot from a Discord server is a destructive action
  // — it stops every course in this organization routing through that
  // server — so it confirms before running, through the one modal
  // primitive this panel shares (`components/modal/ModalProvider.js`).
  const handleRemoveClick = async () => {
    const confirmed = await confirm({
      title: 'Remove this Discord server?',
      description:
        'Every course in this organization stops routing through it until it is installed again.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (confirmed) onRemove()
  }

  if (installedServerId) {
    return (
      <div className="flex items-center gap-3" data-testid="install-button">
        <p className="text-sm text-neutral-700">
          Installed — server <code>{installedServerId}</code>
        </p>
        <Button
          variant="destructive"
          icon={<DeleteIcon aria-hidden="true" className="size-4" />}
          onClick={() => void handleRemoveClick()}
          disabled={removing}
        >
          {removing ? 'Removing…' : 'Remove'}
        </Button>
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
    <div
      className="flex flex-col items-start gap-3"
      data-testid="install-button"
    >
      {/* WEB-15: the one primary action this screen offers. */}
      <Button
        variant="primary"
        onClick={() => void handleClick()}
        disabled={starting}
      >
        {starting ? 'Starting…' : 'Install to Discord'}
      </Button>
      {error && <ErrorMessage error={error} />}
    </div>
  )
}
