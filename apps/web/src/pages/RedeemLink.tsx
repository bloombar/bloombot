/**
 * The page an emailed sign-in link points at (`AUTH-1`,
 * `apps/api/src/index.ts`'s own `buildSignInLink`: `${PUBLIC_APP_URL}/sign-in/:token`).
 * Redeems the token once, on mount, and reports what happened — it never
 * asks the visitor to do anything, since the whole point of the link is
 * that opening it is the action.
 */

import { useEffect, useRef, useState } from 'react'

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
  // `main.tsx` renders under `StrictMode`, which in development mounts,
  // cleans up and re-mounts every effect once as a way of surfacing effects
  // that are not idempotent (React's own documented reason). This one
  // redeems a single-use token — calling it twice means the *second* call
  // is the one whose response wins the race, and it is always a 401
  // ("already redeemed"), so a successful sign-in rendered as a refusal
  // (finding 4 of the WEB-1..6 rework). This ref is what prevents the
  // second call: it survives StrictMode's mount/cleanup/remount (a ref is
  // not reset by an effect's own cleanup), so the second invocation for the
  // same token sees it already set and skips redeeming again. No
  // `cancelled`-flag guard on the promise itself, deliberately: StrictMode's
  // practice cleanup runs the first invocation's cleanup before the
  // still-in-flight redemption resolves, so a flag flipped there would have
  // silently discarded a real response — and React 18+ no longer warns on
  // (or needs guarding against) a state update after a genuine unmount.
  const redeemedTokenRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (redeemedTokenRef.current === token) return
    redeemedTokenRef.current = token

    redeemSignInLink(token).then(onRedeemed, (caught: unknown) => {
      if (caught instanceof ApiError) setState({ kind: 'error', error: caught })
      else throw caught
    })
    // `token` is the only input this effect depends on — `onRedeemed` is a
    // stable callback from `App.tsx`, not state this page re-reads.
  }, [token])

  if (state.kind === 'error') {
    return (
      <div className="mx-auto mt-16 max-w-sm">
        <ErrorMessage error={state.error} />
      </div>
    )
  }
  return (
    <p
      role="status"
      className="mx-auto mt-16 max-w-sm text-sm text-neutral-500"
    >
      Signing you in…
    </p>
  )
}
