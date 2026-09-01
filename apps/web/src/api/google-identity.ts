/**
 * The small sliver of Google's Identity Services API `pages/SignIn.tsx`
 * needs (AUTH-2, WEB-2's "or with Google"). Not a workspace import — Google
 * ships this as a browser script, not an npm package — and, per PLAT-5's
 * own "nothing happens at import time" discipline, the script is fetched
 * only when a visitor actually clicks the Google button, never merely
 * because this module was imported. That matters here more than it would
 * for a Node module: a component test or a browser session with no
 * `googleClientId` configured must never reach `accounts.google.com` (QA-2).
 */

export interface GoogleCredentialResponse {
  /** The ID token — handed straight to `POST /auth/google` (`api/client.ts#signInWithGoogle`); this app never inspects its claims itself. */
  credential: string
}

interface GoogleIdentityServices {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string
        callback: (response: GoogleCredentialResponse) => void
      }) => void
      prompt: () => void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentityServices
  }
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client'

let scriptLoadPromise: Promise<GoogleIdentityServices> | undefined

/** Loads Google's Identity Services script, once, and resolves with `window.google` once it has actually defined it. */
export function loadGoogleIdentityServices(): Promise<GoogleIdentityServices> {
  if (window.google) return Promise.resolve(window.google)
  // `??=` (rather than a plain assignment) is what makes this "once" at
  // all — a second call while the first is still in flight reuses the same
  // promise instead of appending a second `<script>` tag. But a *rejected*
  // promise is just as much "a value" as a resolved one, so `??=` cached
  // that too: once one script load failed (a flaky network, an ad blocker),
  // `scriptLoadPromise` stayed set to the rejected promise forever, and
  // every later call — including the "Try again" `pages/SignIn.tsx` offers
  // after exactly this failure — resolved to that same rejection instantly,
  // with no new `<script>` tag ever appended (cheap-fix 5 of the WEB-1..6
  // rework). Clearing the cache in a `.catch` means a failure is cached
  // only until the next call, which is what actually makes "Try again" able
  // to succeed.
  // Built as a local `const` (typed explicitly) rather than assigned
  // straight onto `scriptLoadPromise` with `??=`: the `.catch` below
  // reassigns `scriptLoadPromise` from a nested closure, and once a
  // module-level variable is reassigned inside any closure, TypeScript can
  // no longer narrow it back to non-`undefined` after this point — the
  // `??` (a read, not an assignment) still short-circuits the same way
  // `??=` did, so a call while a load is already in flight or already
  // cached still reuses the same promise rather than appending a second
  // `<script>` tag.
  const promise: Promise<GoogleIdentityServices> =
    scriptLoadPromise ??
    new Promise<GoogleIdentityServices>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_SRC
      script.async = true
      script.onload = () => {
        if (window.google) resolve(window.google)
        else
          reject(
            new Error(
              'Google Identity Services script loaded but defined no client'
            )
          )
      }
      script.onerror = () =>
        reject(new Error('Could not load Google Identity Services'))
      document.head.appendChild(script)
    }).catch((error: unknown) => {
      scriptLoadPromise = undefined
      throw error
    })
  scriptLoadPromise = promise
  return promise
}
