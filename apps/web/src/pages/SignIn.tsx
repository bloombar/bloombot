/**
 * WEB-2: sign in by emailed link or by Google. Neither path stores a token
 * — the emailed-link path only ever posts to `/auth/request-link` and lets
 * the link itself (opened later, `pages/RedeemLink.tsx`) redeem a session;
 * the Google path hands the ID token straight to `/auth/google` and keeps
 * nothing afterward.
 *
 * **Both paths are gated on accepting the published documents.** There is no
 * separate sign-up screen in this panel — signing in for the first time is how
 * an account comes into being — so this is the only place agreement can be
 * asked for, and it has to gate the Google button as much as the email form.
 * The gate is a disabled control plus `aria-disabled`, not a silent no-op:
 * a button that looks live and does nothing is worse than one that says why.
 */

import { useState } from 'react'

import { ApiError, requestSignInLink, signInWithGoogle } from '../api/client.js'
import { loadGoogleIdentityServices } from '../api/google-identity.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'
import { LEGAL_LINKS } from '../components/legal-links.js'

/**
 * Ties the agreement checkbox to the email form even though it is rendered
 * outside it. HTML's own `form` attribute does exactly this, which keeps
 * `required` doing the work — the browser refuses to submit before any request
 * is made — while letting the checkbox sit above both sign-in options, where
 * it belongs, rather than buried inside one of them.
 */
const FORM_ID = 'sign-in-email-form'

/**
 * Google's own multicolour "G", inlined so the button needs no network and
 * cannot render half-drawn. Reproduced at the proportions Google's sign-in
 * branding guidelines specify; the surrounding button supplies the white
 * background, neutral border and "Continue with Google" wording those same
 * guidelines ask for.
 */
function GoogleGlyph() {
  return (
    <svg className="size-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  )
}

export interface SignInProps {
  /** `import.meta.env.VITE_GOOGLE_CLIENT_ID` by default — a prop so a test can supply, explicitly withhold (`undefined`, the "not configured" case), or omit it without stubbing Vite's env. */
  googleClientId?: string | undefined
  /** Called once `/auth/google` returns a session — the parent re-checks `/auth/me` (`App.tsx`) rather than this component guessing what to show next. */
  onSignedIn: () => void
  /** AUTH-6 — the same-origin path a redeemed sign-in link should return to, whichever browsing context redeems it: passed straight through to `requestSignInLink` (`api/client.ts`), which carries it on the issued token itself. `pages/JoinLink.tsx`, `pages/Connect.tsx` and `pages/Invitation.tsx` are this component's only three callers with anywhere in particular to return to (their own `/join/:secret`/`/connect/:organizationId`/`/invitations/:secret`); every other caller omits it. Not read by the Google path (`handleGoogle`, below) — that sign-in never leaves this tab, so it has nothing to carry a destination for. */
  destination?: string
}

export function SignIn(props: SignInProps) {
  const { onSignedIn, destination } = props
  // `in` rather than a default parameter, which cannot express what
  // `googleClientId`'s own doc comment promises: a default fires for an
  // explicit `undefined` just as it does for an omitted prop, so
  // `<SignIn googleClientId={undefined}>` — the documented way to say "not
  // configured" — silently read the build-time env instead. That went
  // unnoticed while no developer had VITE_GOOGLE_CLIENT_ID set locally, and
  // surfaced as a failing test the moment one did. `in` distinguishes the two
  // cases the props actually have.
  const googleClientId =
    'googleClientId' in props
      ? props.googleClientId
      : import.meta.env['VITE_GOOGLE_CLIENT_ID']
  const [email, setEmail] = useState('')
  const [linkRequested, setLinkRequested] = useState(false)
  const [error, setError] = useState<ApiError | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  // Deliberately not persisted anywhere: the checkbox records that this
  // person was shown the documents and agreed before an account existed, and
  // re-asking on a later sign-in from a new device is the honest behaviour
  // when the acceptance itself is not stored server-side.
  const [accepted, setAccepted] = useState(false)

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
    if (!googleClientId || !accepted) return
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
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-8">
      <h1 className="text-page-title font-semibold text-neutral-900">
        Sign in to Bloombot
      </h1>

      {/* Agreement comes first, above both ways in, because it gates both of
          them. Asking after the buttons would leave the Google button sitting
          disabled above a checkbox explaining why, which reads as a fault
          rather than a precondition. */}
      <label className="flex items-start gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          required
          form={FORM_ID}
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          data-testid="accept-legal"
          className="mt-0.5 size-4 rounded border-neutral-300"
        />
        <span>
          I agree to the{' '}
          {LEGAL_LINKS.map((link, index) => (
            <span key={link.href}>
              {index > 0 && ' and the '}
              <a
                href={link.href}
                className="text-brand-600 underline"
                target="_blank"
                rel="noreferrer"
              >
                {link.label.toLowerCase()}
              </a>
            </span>
          ))}
          .
        </span>
      </label>

      {/* Google is the primary way in, so it sits above the email alternative
          — and it is a real Google-branded control rather than this app's own
          button chrome, which is what Google's own sign-in branding guidelines
          ask of anything initiating an authorization. */}
      {googleClientId ? (
        <button
          type="button"
          disabled={!accepted}
          onClick={() => void handleGoogle()}
          className="flex items-center justify-center gap-3 rounded-md border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
        >
          <GoogleGlyph />
          Continue with Google
        </button>
      ) : (
        <p className="text-sm text-neutral-500">
          Google sign-in is not configured for this deployment.
        </p>
      )}

      <div className="flex items-center gap-3 text-xs text-neutral-400">
        <span className="h-px flex-1 bg-neutral-200" />
        or
        <span className="h-px flex-1 bg-neutral-200" />
      </div>

      <form
        id={FORM_ID}
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
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Email me a sign-in link'}
        </Button>
      </form>
      {error && <ErrorMessage error={error} />}
    </div>
  )
}
