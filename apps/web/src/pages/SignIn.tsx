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
 *
 * **The gate is a real gate, not a visual one — rework round 1 found the
 * first cut of this only looked like one.** Google Identity Services' own
 * `renderButton` has no disabled state of its own, so the button is always
 * drawn once its script has loaded; before the checkbox is ticked, the slot
 * it draws into carries the HTML `inert` attribute (below), which is what
 * actually removes it from both the tab order and the accessibility tree —
 * `pointer-events-none`/dimmed opacity is the *visible* half of the same
 * gate, but blocks a pointer only, and `aria-disabled` alone is advisory:
 * a keyboard user could still tab to GIS's own `div[role="button"]` and
 * press Enter, and the credential callback below has its own `accepted`
 * check besides, since a person can reach that callback by any path.
 * The explanatory sentence is kept *beside* the slot rather than shown
 * *instead of* it, so a person who has not yet ticked the box still sees
 * that Google sign-in exists at all — the earlier, fully-hidden shape hid
 * that from them entirely.
 *
 * MCP-11: `headline` overrides the default title, and `description` renders
 * beneath it — `pages/ConnectAssistant.tsx`'s own caller uses this to name
 * the client asking to connect, safely: this is React, interpolating a
 * client-registered name here is not the hand-escaped string concatenation
 * the old server-rendered consent screen needed (`routes/mcp-oauth-consent.ts`'s
 * own former module comment on why that mattered), which is one of the
 * reasons that screen was worth moving onto this component in the first
 * place.
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
  /** AUTH-6 — the same-origin path a redeemed sign-in link should return to, whichever browsing context redeems it: passed straight through to `requestSignInLink` (`api/client.ts`), which carries it on the issued token itself. `pages/JoinLink.tsx`, `pages/Connect.tsx`, `pages/Invitation.tsx` and `pages/ConnectAssistant.tsx` are this component's only callers with anywhere in particular to return to; every other caller omits it. Not read by the Google path (`handleGoogle`, below) — that sign-in never leaves this tab, so it has nothing to carry a destination for. */
  destination?: string
  /** MCP-11 — overrides the card's own title, default "Sign in to Bloombot". `pages/ConnectAssistant.tsx` is the only caller that sets this today. */
  headline?: string
  /** MCP-11 — an explanatory sentence rendered beneath `headline`, naming *why* this sign-in is happening (e.g. which assistant wants to connect). Omitted by every caller besides `pages/ConnectAssistant.tsx`. */
  description?: string
}

export function SignIn(props: SignInProps) {
  const { onSignedIn, destination, headline, description } = props
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
  //
  // MCP-11, rework round 1 — the slot is always in the DOM once a client id
  // is configured (this file's own module comment on why), but `accepted`
  // is back in this effect's own dependency array rather than left out of
  // it: the credential `callback` below closes over whatever `accepted` was
  // at the moment this effect last ran, so leaving it out of the deps would
  // let a person tick the box *after* this effect first ran and still reach
  // a callback holding a stale, captured `false` — the exact gap a reviewer
  // found. Re-running `initialize`/`renderButton` on every toggle is the
  // cost of keeping that closure honest; Google's own script is already
  // loaded by then, so this is a redraw, not a refetch.
  useEffect(() => {
    if (!googleClientId) return
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
            // The real gate, not merely the visual one (this file's own
            // module comment) — `inert` on the slot already keeps a
            // keyboard user from reaching this callback at all while
            // unaccepted, but this checks the fact the gate exists to
            // protect, not only the one path presumed to reach it.
            if (!accepted) return
            signInWithGoogle(response.credential).then(
              onSignedIn,
              (caught: unknown) => {
                if (caught instanceof ApiError) setError(caught)
                else throw caught
              }
            )
          },
        })
        // This effect re-runs whenever the checkbox is toggled (the
        // dependency-array comment above on why it has to), and GIS is not
        // documented either way on whether `renderButton` replaces what is
        // already in its parent or appends beside it. Emptying the slot
        // first makes that question moot rather than leaving a stacked
        // second button to a browser behaviour nothing here can test —
        // jsdom never loads the real script and the e2e suite deliberately
        // never reaches accounts.google.com (QA-2).
        googleButtonRef.current.replaceChildren()
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
      <div>
        <h1 className="text-page-title font-semibold text-neutral-900">
          {headline ?? 'Sign in to Bloombot'}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-neutral-700">{description}</p>
        )}
      </div>

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
        <div className="flex flex-col items-center gap-2">
          {/* Google draws its own button in here once the script has
              loaded — always, whether or not the documents are accepted
              yet (this file's own module comment on why `renderButton` has
              no disabled state of its own to hand it). `inert` while
              unaccepted is the real gate: it drops the slot from the tab
              order and the accessibility tree, not only from pointer
              events, so a keyboard user cannot reach GIS's own
              `div[role="button"]` and press Enter on it either.
              `pointer-events-none`/dimmed opacity is the *visible* half of
              the same gate; `aria-disabled` is kept alongside for a reader
              that exposes it despite `inert` — a testid rather than a
              role, since there is nothing to query by role until Google
              has rendered into it. */}
          <div
            ref={googleButtonRef}
            data-testid="google-button-slot"
            aria-disabled={!accepted}
            inert={!accepted}
            className={
              accepted
                ? 'flex justify-center'
                : 'pointer-events-none flex justify-center opacity-50'
            }
          />
          {!accepted && (
            <p
              data-testid="google-gated"
              className="text-center text-sm text-neutral-500"
            >
              Agree to the documents above to sign in with Google.
            </p>
          )}
        </div>
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
