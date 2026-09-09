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
 * `SignIn` screen every other entry point uses — passing this exact page's
 * own `organizationId` as `SignIn`'s `destination` prop (AUTH-6), so a
 * returning sign-in lands back here rather than on the ordinary shell
 * (`App.tsx`'s own `returnToShell`), **regardless of which browsing context
 * redeems it** — the destination is carried on the sign-in token itself
 * (`@bloombot/auth`), not in `sessionStorage`, which is per-tab and so only
 * ever worked while the whole round trip stayed in the one browsing context
 * that set it (`docs/DECISIONS.md` D-55 records that original choice; this
 * file's own entry there records what changed and why). Signed in, it
 * offers two independent things to connect — Discord (LINK-7) and an
 * assistant (LINK-8) — neither of which spends anything until its own
 * preview screen is confirmed.
 *
 * LINK-7 (polish slice): once Discord is actually connected, this screen
 * shows a status line in place of the "Connect Discord" button — read from
 * `GET .../person-link/status` (`routes/person-link.ts`) on every mount,
 * not from a flag `App.tsx` passes through after its own post-OAuth
 * navigation. Durability is the point: `App.tsx`'s own `onConnected`
 * already lands the browser back on this exact URL once, right after
 * confirming, but a *later*, unrelated visit needs to show the same
 * "connected" state, which only the server can answer. LINK-6/8's "connect
 * an assistant" section also gets a line of plain-language context here —
 * what it is actually for, not merely a form asking for a token.
 */

import { useEffect, useState } from 'react'

import {
  beginDiscordPersonLink,
  confirmMcpPersonLink,
  getPersonLinkStatus,
  previewMcpPersonLink,
  ApiError,
} from '../api/client.js'
import type {
  AccountSummary,
  PersonLinkPreview,
  PersonLinkStatusResponse,
} from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'
import { Logo } from '../components/Logo.js'
import { describePersonLinkOutcome } from '../person-link-outcome.js'
import { SignIn } from './SignIn.js'

/** Set immediately before `handleConnectDiscord` (below) redirects the browser to Discord's own consent screen, and read back by `pages/DiscordCallback.tsx` on the way back — the same round-trip-surviving device `components/InstallButton.tsx`'s `PENDING_INSTALL_ORG_KEY` already uses for the install flow's identical redirect. This is a same-tab round trip (`window.location.assign`, not an emailed link a mail client might open elsewhere), so `sessionStorage` is the right tool for it — unlike the *sign-in* round trip this page used to also use it for, which AUTH-6 retired in favor of a destination carried on the sign-in token itself (this file's own module comment). */
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

/** LINK-7: the logo and wordmark this page shows above everything else, signed in or out — `pages/Home.tsx`'s own header markup (around its line 85), reused rather than reinvented. */
function BrandHeader() {
  return (
    <header className="flex flex-col items-center text-center">
      <Logo className="size-16" title="Bloombot" />
      <p className="mt-4 text-2xl font-semibold text-neutral-900">Bloombot</p>
    </header>
  )
}

export function Connect({ organizationId, account, onSignedIn }: ConnectProps) {
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const [discordStatus, setDiscordStatus] = useState<
    PersonLinkStatusResponse['discord'] | undefined
  >(undefined)
  const [statusError, setStatusError] = useState<ApiError | undefined>(
    undefined
  )

  // LINK-7: fetched fresh on every mount this screen reaches signed in —
  // `cancelled` guards against setting state from a response that resolves
  // after this component has already unmounted (a fast navigation away),
  // the same device `pages/Courses.tsx#refresh` uses for its own
  // out-of-order guard, simplified here since there is only ever one
  // in-flight request for a given mount.
  useEffect(() => {
    if (!account) return
    let cancelled = false
    getPersonLinkStatus(organizationId).then(
      (response) => {
        if (!cancelled) setDiscordStatus(response.discord)
      },
      (caught: unknown) => {
        if (cancelled) return
        if (caught instanceof ApiError) setStatusError(caught)
        else throw caught
      }
    )
    return () => {
      cancelled = true
    }
  }, [account, organizationId])

  if (!account) {
    // AUTH-6 — `destination` is what carries this page's own address
    // through the sign-in round trip now; see this file's own module
    // comment for why that replaced a `sessionStorage` marker set here.
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
        <BrandHeader />
        <SignIn
          onSignedIn={onSignedIn}
          destination={`/connect/${organizationId}`}
        />
      </div>
    )
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
      <BrandHeader />

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
        {discordStatus === undefined ? (
          // LINK-7 — a quiet loading state while `getPersonLinkStatus`
          // resolves, the same `role="status"` device `pages/Courses.tsx`
          // already uses: never flash the button only to replace it with
          // the connected line a moment later.
          <p role="status" className="text-sm text-neutral-500">
            Loading…
          </p>
        ) : discordStatus.connected ? (
          <p className="text-sm text-neutral-700">
            Discord connected
            {discordStatus.username ? ` as ${discordStatus.username}` : ''}.
          </p>
        ) : (
          <Button
            variant="primary"
            onClick={() => void handleConnectDiscord()}
            disabled={starting}
          >
            {starting ? 'Starting…' : 'Connect Discord'}
          </Button>
        )}
        {error && <ErrorMessage error={error} />}
        {statusError && <ErrorMessage error={statusError} />}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          Connect an assistant
        </h2>
        <p className="text-sm text-neutral-700">
          This connects ChatGPT, Claude and other AI assistants, so you can chat
          with Bloombot from inside those apps.
        </p>
        <McpConnectForm organizationId={organizationId} />
      </div>
    </div>
  )
}
