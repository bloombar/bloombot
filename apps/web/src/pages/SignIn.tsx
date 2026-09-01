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
import { ErrorMessage } from '../components/ErrorMessage.js'

export interface SignInProps {
  /** `import.meta.env.VITE_GOOGLE_CLIENT_ID` by default — a prop so a test can supply, explicitly withhold (`undefined`, the "not configured" case), or omit it without stubbing Vite's env. */
  googleClientId?: string | undefined
  /** Called once `/auth/google` returns a session — the parent re-checks `/auth/me` (`App.tsx`) rather than this component guessing what to show next. */
  onSignedIn: () => void
}

export function SignIn({
  googleClientId = import.meta.env['VITE_GOOGLE_CLIENT_ID'],
  onSignedIn,
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
      await requestSignInLink(email)
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
      <p data-testid="link-requested">
        If an account exists for {email}, a sign-in link is on its way.
      </p>
    )
  }

  return (
    <div className="sign-in">
      <h1>Sign in to Bloombot</h1>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>
      {googleClientId ? (
        <button type="button" onClick={() => void handleGoogle()}>
          Sign in with Google
        </button>
      ) : (
        <p className="google-unconfigured">
          Google sign-in is not configured for this deployment.
        </p>
      )}
      {error && <ErrorMessage error={error} />}
    </div>
  )
}
