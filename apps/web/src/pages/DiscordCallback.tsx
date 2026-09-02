/**
 * `/discord/callback` — where Discord's own consent screen redirects the
 * browser back to, carrying `code`/`state` (and, for an install, `guild_id`)
 * as query parameters. Two flows share this one physical page, told apart
 * by which `sessionStorage` marker is present (`routes/person-link.ts`'s own
 * module comment on why the two flows reuse one registered redirect URI
 * rather than each needing its own):
 *
 *  - `PENDING_INSTALL_ORG_KEY` (`components/InstallButton.tsx`, TEN-4) —
 *    installing the bot into a Discord server.
 *  - `PENDING_CONNECT_ORG_KEY` (`pages/Connect.tsx`, LINK-7) — connecting
 *    the signed-in account's own Discord identity. Unlike the install flow,
 *    this one does not finish in a single call: `code` is exchanged once
 *    (`previewDiscordPersonLink`, LINK-6's own "the page names the account
 *    ... and waits"), and this page shows what confirming would do before
 *    the person is ever asked to — `state` stays unredeemed until
 *    `confirmDiscordPersonLink` actually runs, which only happens on an
 *    explicit click.
 *
 * The organization an install or a connect attempt began for travels across
 * the redirect in `sessionStorage`, not in the URL — Discord controls the
 * query string, and both flows' own server-side state is already scoped to
 * the organization (and, for connect, the survivor) that began it.
 */

import { useEffect, useRef, useState } from 'react'

import {
  ApiError,
  completeDiscordInstall,
  confirmDiscordPersonLink,
  previewDiscordPersonLink,
} from '../api/client.js'
import type { AccountSummary, PersonLinkPreview } from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { PENDING_INSTALL_ORG_KEY } from '../components/InstallButton.js'
import { describePersonLinkOutcome } from '../person-link-outcome.js'
import { PENDING_CONNECT_ORG_KEY } from './Connect.js'

export interface DiscordCallbackProps {
  search: string
  /** LINK-6 — "the page names ... the account signed in". `undefined` only while `App.tsx`'s own session check is still in flight; the preview screen below does not render until an API call resolves, by which point this has settled in practice, but the render below tolerates it being briefly absent rather than assuming it never is. */
  account: AccountSummary | undefined
  /** Called with the organization id and the bound server id once installation succeeds — `App.tsx` carries this back into `pages/Shell.tsx`'s own state. */
  onInstalled: (organizationId: string, serverId: string) => void
  /** LINK-7 — called once a person-link connect attempt is confirmed, so `App.tsx` can return the browser to this same organization's own connect screen rather than the ordinary shell (which a first-time student, with no other membership, would otherwise land on with nothing useful to do there yet). */
  onConnected: (organizationId: string) => void
  /** Return to the shell — offered whether this succeeded or failed, since there is nothing further to do on this page either way. */
  onDone: () => void
}

type State =
  | { kind: 'pending' }
  | { kind: 'error'; error: ApiError }
  | { kind: 'missing' }
  | {
      kind: 'connect-preview'
      organizationId: string
      state: string
      preview: PersonLinkPreview
      discordUsername: string | undefined
    }
  | { kind: 'connect-confirming'; organizationId: string; state: string }

export function DiscordCallback({
  search,
  account,
  onInstalled,
  onConnected,
  onDone,
}: DiscordCallbackProps) {
  const [state, setState] = useState<State>({ kind: 'pending' })
  // `main.tsx` renders under `StrictMode`, which mounts, cleans up and
  // re-mounts every effect once in development. Both flows below spend a
  // single-use secret exactly once for the same reason
  // `pages/RedeemLink.tsx`'s own module comment already explains in detail
  // — a ref that survives the mount/cleanup/remount, no `cancelled`-flag
  // guard on the promise itself, since StrictMode's practice cleanup would
  // flip it before the still-in-flight call resolves and silently discard a
  // real response.
  const dispatchedSearchRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    const params = new URLSearchParams(search)
    const code = params.get('code')
    const stateParam = params.get('state')
    const guildId = params.get('guild_id')

    const installOrganizationId = sessionStorage.getItem(
      PENDING_INSTALL_ORG_KEY
    )
    const connectOrganizationId = sessionStorage.getItem(
      PENDING_CONNECT_ORG_KEY
    )

    if (installOrganizationId && code && stateParam && guildId) {
      if (dispatchedSearchRef.current === search) return
      dispatchedSearchRef.current = search

      completeDiscordInstall(installOrganizationId, {
        code,
        state: stateParam,
        guildId,
      }).then(
        (result) => {
          sessionStorage.removeItem(PENDING_INSTALL_ORG_KEY)
          onInstalled(installOrganizationId, result.serverId)
        },
        (caught: unknown) => {
          sessionStorage.removeItem(PENDING_INSTALL_ORG_KEY)
          if (caught instanceof ApiError)
            setState({ kind: 'error', error: caught })
          else throw caught
        }
      )
      return
    }

    if (connectOrganizationId && code && stateParam) {
      if (dispatchedSearchRef.current === search) return
      dispatchedSearchRef.current = search

      // LINK-6: this spends the OAuth `code` (once) but not `state` — the
      // preview below is what the person sees before anything is actually
      // bound. `sessionStorage` is cleared here, not on confirm: the code
      // exchange is what could only ever run once regardless, and leaving
      // the marker set until confirm would make a page reload between
      // preview and confirm land back on `previewDiscordPersonLink` with an
      // already-spent code.
      sessionStorage.removeItem(PENDING_CONNECT_ORG_KEY)
      previewDiscordPersonLink(connectOrganizationId, {
        code,
        state: stateParam,
      }).then(
        (response) => {
          setState({
            kind: 'connect-preview',
            organizationId: connectOrganizationId,
            state: stateParam,
            preview: response.preview,
            discordUsername: response.discordUsername,
          })
        },
        (caught: unknown) => {
          if (caught instanceof ApiError)
            setState({ kind: 'error', error: caught })
          else throw caught
        }
      )
      return
    }

    // Reached this page directly, or the browser dropped the query string
    // or the pending marker somewhere along the way — nothing here to
    // complete.
    setState({ kind: 'missing' })
    // `search` is the only input this effect depends on — `onInstalled`/
    // `onConnected` are stable callbacks from `App.tsx`, not state this
    // page re-reads.
  }, [search])

  const handleConfirm = async (organizationId: string, stateValue: string) => {
    setState({ kind: 'connect-confirming', organizationId, state: stateValue })
    try {
      await confirmDiscordPersonLink(organizationId, stateValue)
      onConnected(organizationId)
    } catch (caught) {
      if (caught instanceof ApiError) setState({ kind: 'error', error: caught })
      else throw caught
    }
  }

  if (state.kind === 'connect-preview') {
    const {
      organizationId,
      state: stateValue,
      preview,
      discordUsername,
    } = state
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-4">
        <h1 className="text-page-title font-semibold text-neutral-900">
          Connect Discord
        </h1>
        {account && (
          <p className="text-sm text-neutral-700">
            Signed in as <strong>{account.email}</strong>
          </p>
        )}
        {discordUsername && (
          <p className="text-sm text-neutral-700">
            Discord account: <strong>{discordUsername}</strong>
          </p>
        )}
        <p className="text-sm text-neutral-700">
          {describePersonLinkOutcome(preview.outcome)}
        </p>
        <div className="flex gap-3">
          <Button
            variant="primary"
            onClick={() => void handleConfirm(organizationId, stateValue)}
          >
            Confirm connecting
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (state.kind === 'connect-confirming') {
    return (
      <p
        role="status"
        className="mx-auto mt-16 max-w-sm text-sm text-neutral-500"
      >
        Connecting…
      </p>
    )
  }

  if (state.kind === 'missing') {
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-4">
        <p className="text-sm text-neutral-700">
          There is nothing to complete here.
        </p>
        <Button variant="secondary" onClick={onDone}>
          Return to the control panel
        </Button>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-4">
        <ErrorMessage error={state.error} />
        <Button variant="secondary" onClick={onDone}>
          Return to the control panel
        </Button>
      </div>
    )
  }
  return (
    <p
      role="status"
      className="mx-auto mt-16 max-w-sm text-sm text-neutral-500"
    >
      Finishing…
    </p>
  )
}
