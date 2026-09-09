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

import { useEffect, useRef, useState } from 'react'

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

  // Where Google draws its own button. A ref rather than an id, because two
  // `SignIn`s on one page (the home page embeds one) would otherwise both
  // render into whichever element happened to win the id.
  const googleButtonRef = useRef<HTMLDivElement | null>(null)

  // Loading the script and rendering the button happen here rather than on a
  // click: `renderButton` needs a mounted element to draw into, and the button
  // it draws *is* the control — there is nothing left for an onClick to do.
  // The script is still fetched only when a client id is configured, so a
  // deployment without Google sign-in never reaches accounts.google.com (QA-2).
  useEffect(() => {
    // Gated on `accepted` as well as configuration: Google renders and owns
    // that button, so it cannot be handed a `disabled` prop the way this
    // app's own controls can, and dimming it with CSS would be a gate only
    // until someone opened devtools. Not drawing it at all is a real one.
    if (!googleClientId || !accepted) return
    const parent = googleButtonRef.current
    if (!parent) return

    let cancelled = false
    loadGoogleIdentityServices()
      .then((google) => {
        // The component may have unmounted, or the id changed, while the
        // script was in flight; drawing into a detached node would leave a
        // button nobody can see and a callback nobody wants.
        if (cancelled || !googleButtonRef.current) return
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
        google.accounts.id.renderButton(googleButtonRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: 320,
        })
      })
      .catch(() => {
        if (cancelled) return
        setError(
          new ApiError(0, {
            error: 'google_unavailable',
          })
        )
      })

    return () => {
      cancelled = true
    }
  }, [googleClientId, accepted, onSignedIn])

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
        accepted ? (
          // Google draws its own button in here once the script has loaded.
          // Empty in the DOM until then, which is why it carries a testid
          // rather than a role: there is nothing to query by role until
          // Google has rendered into it.
          <div
            ref={googleButtonRef}
            data-testid="google-button-slot"
            className="flex justify-center"
          />
        ) : (
          <p
            data-testid="google-gated"
            className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-center text-sm text-neutral-500"
          >
            Agree to the documents above to sign in with Google.
          </p>
        )
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
