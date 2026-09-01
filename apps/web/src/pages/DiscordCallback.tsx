/**
 * `/discord/callback` (TEN-4): where Discord's own consent screen redirects
 * the browser back to, carrying `code`/`state`/`guild_id` as query
 * parameters — `apps/api`'s `discordRedirectUri`
 * (`${PUBLIC_APP_URL}/discord/callback`, `apps/api/src/index.ts`) names
 * this exact path, so it must stay in sync with that value by hand; nothing
 * makes the two the same constant today.
 *
 * The organization this install began for travels across the redirect in
 * `sessionStorage` (`components/InstallButton.tsx`), not in the URL —
 * Discord controls the query string, and TEN-4's install-state row is
 * already scoped to both the organization and the account that began it, so
 * this page's only job is handing all three values to
 * `POST .../install/callback` and reporting what it says.
 *
 * WEB-4's outcomes: **bound** (200, a `serverId`) or **refused** — every
 * refusal reason `apps/api` can hit here (an unknown/expired/replayed
 * state, a guild the caller does not administer, a guild the bot was never
 * added to, a server already bound elsewhere) comes back as the exact same
 * `action_refused` (TEN-5: deliberately indistinguishable — see
 * `docs/DECISIONS.md`), so this page shows the one refusal message
 * `ErrorMessage` already renders for that code rather than inventing three
 * different ones the API itself does not distinguish.
 */

import { useEffect, useState } from 'react'

import { ApiError, completeDiscordInstall } from '../api/client.js'
import { PENDING_INSTALL_ORG_KEY } from '../components/InstallButton.js'
import { ErrorMessage } from '../components/ErrorMessage.js'

export interface DiscordCallbackProps {
  search: string
  /** Called with the organization id and the bound server id once installation succeeds — `App.tsx` carries this back into `pages/Shell.tsx`'s own state. */
  onInstalled: (organizationId: string, serverId: string) => void
  /** Return to the shell — offered whether this succeeded or failed, since there is nothing further to do on this page either way. */
  onDone: () => void
}

type State =
  { kind: 'pending' } | { kind: 'error'; error: ApiError } | { kind: 'missing' }

export function DiscordCallback({
  search,
  onInstalled,
  onDone,
}: DiscordCallbackProps) {
  const [state, setState] = useState<State>({ kind: 'pending' })

  useEffect(() => {
    let cancelled = false
    const organizationId = sessionStorage.getItem(PENDING_INSTALL_ORG_KEY)
    const params = new URLSearchParams(search)
    const code = params.get('code')
    const stateParam = params.get('state')
    const guildId = params.get('guild_id')

    if (!organizationId || !code || !stateParam || !guildId) {
      // Reached this page directly, or the browser dropped the query
      // string somewhere along the way — nothing here to complete.
      setState({ kind: 'missing' })
      return
    }

    completeDiscordInstall(organizationId, {
      code,
      state: stateParam,
      guildId,
    }).then(
      (result) => {
        sessionStorage.removeItem(PENDING_INSTALL_ORG_KEY)
        if (!cancelled) onInstalled(organizationId, result.serverId)
      },
      (caught: unknown) => {
        sessionStorage.removeItem(PENDING_INSTALL_ORG_KEY)
        if (cancelled) return
        if (caught instanceof ApiError)
          setState({ kind: 'error', error: caught })
        else throw caught
      }
    )
    return () => {
      cancelled = true
    }
    // `search` is the only input this effect depends on — `onInstalled` is a
    // stable callback from `App.tsx`, not state this page re-reads.
  }, [search])

  if (state.kind === 'missing') {
    return (
      <div>
        <p>There is nothing to complete here.</p>
        <button type="button" onClick={onDone}>
          Return to the control panel
        </button>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div>
        <ErrorMessage error={state.error} />
        <button type="button" onClick={onDone}>
          Return to the control panel
        </button>
      </div>
    )
  }
  return <p>Finishing installation…</p>
}
