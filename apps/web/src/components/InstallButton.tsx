/**
 * WEB-4: the button that installs the bot into a Discord server.
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
 * TEN-9 — this component is now *only* the install action: an organization
 * can bind more than one Discord server, so "already installed" is no
 * longer a single state this button switches on. `pages/Shell.tsx` renders
 * one `DiscordServerRow` (below) per active binding, each with its own
 * Remove, and this button underneath them, unconditionally — "installing
 * another" rather than the single Install/Remove pair this component used
 * to be. Before this slice, an `installedServerId` prop decided which of
 * two branches this rendered; that branch (the "already installed" half)
 * is what `DiscordServerRow` is, split out rather than deleted.
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
}

export function InstallButton({ organizationId }: InstallButtonProps) {
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [starting, setStarting] = useState(false)

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
      {/* WEB-15: the one primary action this component offers. */}
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

export interface DiscordServerRowProps {
  /** The active binding's own server id — always defined; a row is only ever rendered for a binding that exists (`pages/Shell.tsx`'s own `installedServerIds`). */
  serverId: string
  onRemove: () => void
  removing: boolean
}

/**
 * TEN-9 — one active Discord server binding, with its own Remove. Split out
 * of `InstallButton`'s old "already installed" branch (this file's own
 * module comment) so `pages/Shell.tsx` can render one per active binding,
 * each independently removable, rather than the single Install/Remove pair
 * this panel offered before an organization could hold more than one.
 */
export function DiscordServerRow({
  serverId,
  onRemove,
  removing,
}: DiscordServerRowProps) {
  const { confirm } = useModal()

  // WEB-15: removing the bot from a Discord server is a destructive action
  // — it stops every course routing through *that* server — so it confirms
  // before running, through the one modal primitive this panel shares
  // (`components/modal/ModalProvider.js`).
  const handleRemoveClick = async () => {
    const confirmed = await confirm({
      title: 'Remove this Discord server?',
      description:
        'Every course routing through it stops answering until it is installed again.',
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (confirmed) onRemove()
  }

  return (
    <div className="flex items-center gap-3" data-testid="install-button">
      <p className="text-sm text-neutral-700">
        Installed — server <code>{serverId}</code>
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
