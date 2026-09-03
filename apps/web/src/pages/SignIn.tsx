/**
 * WEB-2: sign in by emailed link or by Google. Neither path stores a token
 * — the emailed-link path only ever posts to `/auth/request-link` and lets
 * the link itself (opened later, `pages/RedeemLink.tsx`) redeem a session;
 * the Google path hands the ID token straight to `/auth/google` and keeps
 * nothing afterward.
 */

import { useState } from 'react'

import { ApiError, requestSignInLink, signInWithGoogle } from '../api/client.js'
import { loadGoogleIdentityServices } from '../api/google-identity.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'

export interface SignInProps {
  /** `import.meta.env.VITE_GOOGLE_CLIENT_ID` by default — a prop so a test can supply, explicitly withhold (`undefined`, the "not configured" case), or omit it without stubbing Vite's env. */
  googleClientId?: string | undefined
  /** Called once `/auth/google` returns a session — the parent re-checks `/auth/me` (`App.tsx`) rather than this component guessing what to show next. */
  onSignedIn: () => void
  /** AUTH-6 — the same-origin path a redeemed sign-in link should return to, whichever browsing context redeems it: passed straight through to `requestSignInLink` (`api/client.ts`), which carries it on the issued token itself. `pages/JoinLink.tsx` and `pages/Connect.tsx` are this component's only two callers with anywhere in particular to return to (their own `/join/:secret`/`/connect/:organizationId`); every other caller omits it. Not read by the Google path (`handleGoogle`, below) — that sign-in never leaves this tab, so it has nothing to carry a destination for. */
  destination?: string
}

export function SignIn({
  googleClientId = import.meta.env['VITE_GOOGLE_CLIENT_ID'],
  onSignedIn,
  destination,
}: SignInProps) {
  const [email, setEmail] = useState('')
  const [linkRequested, setLinkRequested] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setSubmitting(true)
    try {
      await requestSignInLink(email, destination)
      setLinkRequested(true)
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught)
      else throw caught
    } finally {
      setSubmitting(false)
    }
  }

  const handleGoogle = async () => {
    if (!googleClientId) return
    setError(undefined)
    try {
      const google = await loadGoogleIdentityServices()
      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response) => {
          signInWithGoogle(response.credential).then(
            onSignedIn,
            (caught: unknown) => {
              if (caught instanceof ApiError) setError(caught)
              else throw caught
            }
          )
        },
      })
      google.accounts.id.prompt()
    } catch {
      setError(
        new ApiError(0, {
          error: 'google_unavailable',
        })
      )
    }
  }

  if (linkRequested) {
    return (
      <p
        data-testid="link-requested"
        role="status"
        className="mx-auto mt-16 max-w-sm text-center text-sm text-neutral-700"
      >
        If an account exists for {email}, a sign-in link is on its way.
      </p>
    )
  }

  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col gap-6">
      <h1 className="text-page-title font-semibold text-neutral-900">
        Sign in to Bloombot
      </h1>
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="flex flex-col gap-4"
      >
        <FormField label="Email">
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={textInputClasses}
          />
        </FormField>
        {/* WEB-15: the one primary action on this screen. */}
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Email me a sign-in link'}
        </Button>
      </form>
      {googleClientId ? (
        <Button variant="secondary" onClick={() => void handleGoogle()}>
          Sign in with Google
        </Button>
      ) : (
        <p className="text-sm text-neutral-500">
          Google sign-in is not configured for this deployment.
        </p>
      )}
      {error && <ErrorMessage error={error} />}
    </div>
  )
}
