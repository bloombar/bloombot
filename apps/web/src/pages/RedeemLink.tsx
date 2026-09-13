/**
 * The page an emailed sign-in link points at (`AUTH-1`,
 * `apps/api/src/index.ts`'s own `buildSignInLink`: `${PUBLIC_APP_URL}/sign-in/:token`).
 * Redeems the token once, on mount, and reports what happened — it never
 * asks the visitor to do anything, since the whole point of the link is
 * that opening it is the action, unless redemption fails.
 *
 * **MCP-12's own second half — the failure state is a page of this app like
 * any other, and an expired link can be asked for again without leaving
 * it.** Before this, a failed redemption rendered a bare `<ErrorMessage>` in
 * an unbranded `max-w-sm` div with no way forward — the concrete failure
 * this exists to fix: a mail queue takes twenty minutes, the pending
 * authorization it was for is still live at MCP-12's own new sixty-minute
 * TTL, but the sign-in token itself expired at fifteen (`tokens.ts#DEFAULT_TOKEN_TTL_MS`,
 * deliberately unchanged — AUTH-1's "expire within minutes" is a different,
 * correct concern). A person who followed the link from their assistant has
 * no URL to go back to and no reason to think trying again would work
 * differently. Now the failure state carries `SignInHeader` and the panel's
 * own layout, states plainly that starting over from the assistant also
 * works, and re-embeds `SignIn` so a fresh link can be requested right here.
 *
 * **Carrying the destination through a token that no longer exists.**
 * `SignIn`'s `destination` prop is normally carried on the *token itself*
 * (AUTH-6) — exactly the thing this page can no longer read once redemption
 * has failed. `buildSignInLink` (`apps/api/src/index.ts`) also appends it as
 * a `?destination=` query parameter on the emailed link's own URL, purely as
 * a recovery hint for this page to read back — never a second source of
 * truth: a *successful* redemption still returns `result.destination` from
 * the server's own stored value (`consumeSignInToken`, `@bloombot/auth`),
 * and this page's own retry re-validates the hint with the identical
 * `isSameOriginPath` check every other caller of `SignIn`'s `destination`
 * prop already goes through before using it (`App.tsx`'s own duplicated
 * copy, `docs/DECISIONS.md` D-34's "small, deliberately duplicated pure
 * function" precedent).
 */

import { useEffect, useRef, useState } from 'react'

import { ApiError, redeemSignInLink } from '../api/client.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { SignInHeader } from '../components/SignInHeader.js'
import { SignIn } from './SignIn.js'

export interface RedeemLinkProps {
  token: string
  /** Called once redemption succeeds, with the destination the *token itself* carried (AUTH-6) — `undefined` for an ordinary sign-in with nowhere in particular to return to. The parent (`App.tsx`) re-checks `/auth/me` and navigates there (falling back to the shell), rather than this page assuming what comes next or where. Also called after a retry's own Google sign-in succeeds, since that path never redeems a token at all — carrying the *hinted* destination (below) straight through, the best information this page has once the original token cannot be looked up. */
  onRedeemed: (destination: string | undefined) => void
}

type State = { kind: 'pending' } | { kind: 'error'; error: ApiError }

/** `App.tsx`'s own duplicated `isSameOriginPath` (that file's module comment on why it is copied rather than imported from `@bloombot/auth` — PLAT-2's "`apps/web` only ever imports `@bloombot/schemas` from the workspace"). Copied a second time here rather than exported from `App.tsx`, the same small-pure-function trade `docs/DECISIONS.md` D-34 already made for `repos/course-join-links.ts`'s own `hashSecret`. */
function isSameOriginPath(value: string): boolean {
  if (!/^\/(?!\/|\\)/.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x20) return false
  }
  return true
}

/** The `?destination=` hint off this page's own URL (`buildSignInLink`'s own doc comment on why it is only ever a hint) — `undefined` for a link issued with no destination, and for anything that fails `isSameOriginPath`, the identical gate the server itself re-checks before ever trusting a destination. */
function destinationHint(): string | undefined {
  const raw = new URLSearchParams(window.location.search).get('destination')
  if (raw === null) return undefined
  return isSameOriginPath(raw) ? raw : undefined
}

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

    redeemSignInLink(token).then(
      (result) => onRedeemed(result.destination),
      (caught: unknown) => {
        if (caught instanceof ApiError)
          setState({ kind: 'error', error: caught })
        else throw caught
      }
    )
    // `token` is the only input this effect depends on — `onRedeemed` is a
    // stable callback from `App.tsx`, not state this page re-reads.
  }, [token])

  if (state.kind === 'error') {
    // MCP-12 — only a *refused* redemption means the link itself is spent.
    // A `network_error` (`api/client.ts`: `fetch` rejected, nothing ever
    // arrived) or a 5xx says nothing about the token, and telling someone
    // their link expired when the network merely blinked pushes them into
    // requesting a replacement they do not need — which `requestSignInLink`'s
    // own anti-flood guard (`@bloombot/auth`) then silently declines while a
    // live token is still outstanding, so they wait for a second email that
    // is never sent. Those cases keep the plain `ErrorMessage` they had
    // before this slice, which already says "try again" rather than "start
    // over".
    if (state.error.status !== 401 && state.error.status !== 400) {
      return (
        <div className="mx-auto mt-16 max-w-sm">
          <ErrorMessage error={state.error} />
        </div>
      )
    }
    // MCP-12 — read once, not on every render: the query string cannot
    // change under this page (a fresh `/sign-in/:token` navigation
    // unmounts and remounts it with a new `token` entirely), so this is a
    // plain call rather than its own piece of state.
    const destination = destinationHint()
    return (
      <div className="mx-auto mt-16 flex max-w-sm flex-col gap-8">
        <SignInHeader />
        <p className="text-sm text-neutral-700">
          This sign-in link no longer works — it may have expired, already been
          used, or been requested again since. If you followed it from an
          assistant or another app, going back there and starting the connection
          again also works. If it simply expired, request a new one below and it
          will return you here once you sign in.
        </p>
        <SignIn
          onSignedIn={() => onRedeemed(destination)}
          {...(destination !== undefined ? { destination } : {})}
        />
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
