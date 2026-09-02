/**
 * `/connect/:organizationId` (LINK-6/7/8) — the address `packages/discord`'s
 * own `connectInvitationText` sends an unconnected Discord identity to
 * (LINK-1/LINK-2). `:organizationId` is not a secret (LINK-2's own concern
 * is a claim *token*, not a plain identifier — `routes/person-link.ts`'s
 * own module comment has the fuller reasoning); it names which
 * organization's own person this screen's "Connect Discord" button should
 * bind to, so the OAuth round trip resolves the roster- or role-admitted
 * person already waiting there (LINK-4).
 *
 * A visit alone does nothing (LINK-6's own "does nothing until the person
 * says to"): signed out, this page asks the visitor to sign in — the same
 * `SignIn` screen every other entry point uses — and stashes
 * `organizationId` (`PENDING_CONNECT_ORG_KEY`) so a returning sign-in (an
 * emailed link, opened in the same tab or a fresh one) lands back here
 * rather than on the ordinary shell (`App.tsx`'s own `returnToShell`).
 * Signed in, it offers two independent things to connect — Discord
 * (LINK-7) and an assistant (LINK-8) — neither of which spends anything
 * until its own preview screen is confirmed.
 */

import { useEffect, useState } from 'react'

import {
  beginDiscordPersonLink,
  confirmMcpPersonLink,
  previewMcpPersonLink,
  ApiError,
} from '../api/client.js'
import type { AccountSummary, PersonLinkPreview } from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'
import { describePersonLinkOutcome } from '../person-link-outcome.js'
import { SignIn } from './SignIn.js'

/** Set the moment this page mounts (signed in or not) and read back by `App.tsx`'s own `returnToShell` — the same round-trip-surviving device `components/InstallButton.tsx`'s `PENDING_INSTALL_ORG_KEY` already uses for the Discord OAuth redirect, applied here so a sign-in redemption (a *different* round trip) also lands back on this exact organization's own connect screen rather than the ordinary shell. */
export const PENDING_CONNECT_ORG_KEY = 'bloombot:pendingConnectOrganizationId'

export interface ConnectProps {
  organizationId: string
  account: AccountSummary | null
  onSignedIn: () => void
}

function McpConnectForm({ organizationId }: { organizationId: string }) {
  const [token, setToken] = useState('')
  const [preview, setPreview] = useState<PersonLinkPreview | undefined>(
    undefined
  )
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)

  const handlePreview = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      const response = await previewMcpPersonLink(organizationId, token)
      setPreview(response.preview)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusy(false)
    }
  }

  const handleConfirm = async () => {
    setError(undefined)
    setBusy(true)
    try {
      await confirmMcpPersonLink(organizationId, token)
      setConnected(true)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setBusy(false)
    }
  }

  if (connected) {
    return (
      <p role="status" className="text-sm text-neutral-700">
        Your assistant is connected.
      </p>
    )
  }

  // LINK-6 — the preview names the outcome and waits; the token is not
  // redeemed until "Confirm connecting" is clicked.
  if (preview) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-700">
          {describePersonLinkOutcome(preview.outcome)}
        </p>
        <div className="flex gap-3">
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? 'Connecting…' : 'Confirm connecting'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPreview(undefined)}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
        {error && <ErrorMessage error={error} />}
      </div>
    )
  }

  return (
    <form
      onSubmit={(event) => void handlePreview(event)}
      className="flex flex-col gap-3"
    >
      <FormField
        label="Assistant token"
        help="Ask your assistant to connect itself, then paste the token it gives you here."
      >
        <input
          type="text"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className={textInputClasses}
        />
      </FormField>
      <Button variant="primary" type="submit" disabled={busy || !token}>
        {busy ? 'Checking…' : 'Continue'}
      </Button>
      {error && <ErrorMessage error={error} />}
    </form>
  )
}

export function Connect({ organizationId, account, onSignedIn }: ConnectProps) {
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [starting, setStarting] = useState(false)

  // Cleared the moment this screen has an account to work with — its only
  // job was surviving a full-page navigation (a sign-in redemption's own
  // round trip, `App.tsx`'s own `returnToShell`) that has now already
  // happened; a stale value left behind would otherwise redirect a later,
  // unrelated sign-in back to this organization's connect screen.
  useEffect(() => {
    if (account) sessionStorage.removeItem(PENDING_CONNECT_ORG_KEY)
  }, [account])

  if (!account) {
    sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, organizationId)
    return <SignIn onSignedIn={onSignedIn} />
  }

  const handleConnectDiscord = async () => {
    setError(undefined)
    setStarting(true)
    try {
      // Kept live across the Discord round trip the same way
      // `InstallButton.tsx` keeps its own install organization —
      // `DiscordCallback.tsx` reads this key to tell a person-link attempt
      // apart from an install one on the way back.
      sessionStorage.setItem(PENDING_CONNECT_ORG_KEY, organizationId)
      const begun = await beginDiscordPersonLink(organizationId)
      window.location.assign(begun.authorizationUrl)
    } catch (caught) {
      setStarting(false)
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    }
  }

  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-page-title font-semibold text-neutral-900">
          Connect your account
        </h1>
        <p className="text-sm text-neutral-700">
          Signed in as {account.email}. Connecting proves the account and links
          its conversation history — nothing happens until you say so.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          Connect Discord
        </h2>
        <p className="text-sm text-neutral-700">
          Sends you to Discord's own sign-in screen, then back here to confirm.
        </p>
        <Button
          variant="primary"
          onClick={() => void handleConnectDiscord()}
          disabled={starting}
        >
          {starting ? 'Starting…' : 'Connect Discord'}
        </Button>
        {error && <ErrorMessage error={error} />}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          Connect an assistant
        </h2>
        <McpConnectForm organizationId={organizationId} />
      </div>
    </div>
  )
}
