/**
 * The page an emailed sign-in link points at (`AUTH-1`,
 * `apps/api/src/index.ts`'s own `buildSignInLink`: `${PUBLIC_APP_URL}/sign-in/:token`).
 * Redeems the token once, on mount, and reports what happened — it never
 * asks the visitor to do anything, since the whole point of the link is
 * that opening it is the action.
 */

import { useEffect, useState } from 'react'

import { ApiError, redeemSignInLink } from '../api/client.js'
import { ErrorMessage } from '../components/ErrorMessage.js'

export interface RedeemLinkProps {
  token: string
  /** Called once redemption succeeds — the parent re-checks `/auth/me` and navigates to the shell (`App.tsx`), rather than this page assuming what comes next. */
  onRedeemed: () => void
}

type State = { kind: 'pending' } | { kind: 'error'; error: ApiError }

export function RedeemLink({ token, onRedeemed }: RedeemLinkProps) {
  const [state, setState] = useState<State>({ kind: 'pending' })

  useEffect(() => {
    let cancelled = false
    redeemSignInLink(token).then(
      () => {
        if (!cancelled) onRedeemed()
      },
      (caught: unknown) => {
        if (cancelled) return
        if (caught instanceof ApiError)
          setState({ kind: 'error', error: caught })
        else throw caught
      }
    )
    return () => {
      cancelled = true
    }
    // `token` is the only input this effect depends on — `onRedeemed` is a
    // stable callback from `App.tsx`, not state this page re-reads.
  }, [token])

  if (state.kind === 'error') {
    return <ErrorMessage error={state.error} />
  }
  return <p>Signing you in…</p>
}
