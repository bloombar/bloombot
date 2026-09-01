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
  scriptLoadPromise ??= new Promise((resolve, reject) => {
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
  })
  return scriptLoadPromise
}
