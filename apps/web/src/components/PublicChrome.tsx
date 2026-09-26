/**
 * WEB-76 — the header bar and drawer the published legal documents
 * (`pages/StaticDocument.tsx`) use, reusing `components/AppShell.tsx`
 * rather than the signed-in `SignedInChrome`: there is no organization to
 * act in here, so the header names the app itself, never an organization,
 * and the drawer offers one link — "Log in or sign up" signed out, "Back
 * to Bloombot" signed in — both `{ kind: 'home' }`, which `App.tsx`'s own
 * `resolveHomeRoute` resolves to the right screen per session. `AppShell`'s
 * own footer and Legal drawer links (Privacy/Terms) are unchanged.
 */

import type { ReactNode } from 'react'

import type { Route } from '../routing/route.js'
import { AppShell } from './AppShell.js'

export interface PublicChromeProps {
  /** Whether a session is currently signed in — decides which drawer item renders. `false` is the right default before a session is known (`pages/StaticDocument.tsx`'s own doc comment). */
  signedIn: boolean
  navigate: (route: Route) => void
  children: ReactNode
}

export function PublicChrome({
  signedIn,
  navigate,
  children,
}: PublicChromeProps) {
  const goHome = () => navigate({ kind: 'home' })
  return (
    <AppShell
      onHome={goHome}
      navGroups={[
        {
          key: 'public',
          items: [
            {
              key: signedIn ? 'back' : 'sign-in',
              label: signedIn ? 'Back to Bloombot' : 'Log in or sign up',
              onClick: goHome,
              active: false,
            },
          ],
        },
      ]}
      headerStart={
        // The app itself, never an organization.
        <span className="text-sm font-medium text-neutral-900">
          Bloombot{' '}
          <span className="font-normal text-neutral-500">
            — AI course assistant
          </span>
        </span>
      }
      headerEnd={null}
      drawerFooter={null}
    >
      {children}
    </AppShell>
  )
}
