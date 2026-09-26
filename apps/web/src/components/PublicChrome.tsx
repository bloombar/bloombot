/**
 * WEB-76 rework round 1 — the coordinator's own correction: a centred,
 * menu-less hero (`SignInHeader`, this file's own predecessor here) is not
 * the header bar the brief actually asked for. The published legal
 * documents (`pages/StaticDocument.tsx`) now get the same conventional
 * header-bar-plus-drawer chrome every signed-in screen already has
 * (`components/AppShell.tsx`), reused rather than hand-rolled a second
 * time — the same "one implementation, not two that can drift apart"
 * reasoning `components/SignedInChrome.tsx`'s own module comment already
 * gives for existing at all.
 *
 * **Deliberately not `SignedInChrome`.** These two pages have no
 * organization to act in — the header names the *app* itself (its logo,
 * "Bloombot", and a one-line description), never an organization, and the
 * drawer offers only what a reader with no membership context needs: a way
 * to sign in (or a way back into the app, already signed in). Building a
 * second, small `AppShell` caller for that — rather than teaching
 * `SignedInChrome` an organization-less "public" mode — keeps that file's
 * own already-considerable branching (`activeOrganizationId === undefined`,
 * three times over) from growing a fourth axis for a case it was never
 * meant to cover.
 *
 * **`{ kind: 'home' }` is every one of this drawer's own destinations,
 * whether signed in or out.** `App.tsx`'s own `resolveHomeRoute` effect
 * already resolves that one address to whichever landing screen the
 * caller's own session earns it the instant it renders — the sign-in
 * screen, signed out; the account's own default organization, signed in —
 * so "Log in or sign up," "Home" and "Back to Bloombot" all point at the
 * identical address on purpose, rather than this file inventing a second
 * one for "home" distinct from "where signing in happens." (They read as
 * three different links because they *are* three different affordances a
 * reader recognises — "how do I get in," "what is the plain landing page,"
 * "take me back" — even though today's `App.tsx` resolves all three to the
 * same place.)
 *
 * **`AppShell`'s own footer stays** (its Legal/Support links, unmodified);
 * this component does not override it. `docs/DECISIONS.md`'s WEB-76 entry
 * records why: `AppShell`'s built-in footer is a *fixed*, `h-footer`-sized
 * bar the surrounding `<main>`'s own padding is sized to leave room for —
 * substituting a plain, non-fixed `SiteFooter` in its place would either
 * leave a gap (nothing filling the reserved space) or need `AppShell`
 * itself reworked to stop reserving it, for no material difference in what
 * either footer actually offers a reader (both link to the same two
 * documents; `AppShell`'s own copy adds a Support address and the year).
 */

import type { ReactNode } from 'react'

import type { Route } from '../routing/route.js'
import { AppShell } from './AppShell.js'

export interface PublicChromeProps {
  /** Whether a session is currently signed in — decides which single drawer item renders: "Log in or sign up" when it is not, "Back to Bloombot" when it is. `false` is the safe default a caller with no session to check yet should pass (`pages/StaticDocument.tsx`'s own doc comment on why that is always true for the very first paint, even for an account that turns out to be signed in). */
  signedIn: boolean
  /** Pushes to a new address — `pages/App.tsx`'s own `navigate`, threaded straight through the same way every other screen already receives it. */
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
          items: signedIn
            ? [
                {
                  key: 'back',
                  label: 'Back to Bloombot',
                  onClick: goHome,
                  active: false,
                },
              ]
            : [
                {
                  key: 'sign-in',
                  label: 'Log in or sign up',
                  onClick: goHome,
                  active: false,
                },
                {
                  key: 'home',
                  label: 'Home',
                  onClick: goHome,
                  active: false,
                },
              ],
        },
      ]}
      headerStart={
        // The app itself, never an organization — this file's own module
        // comment on why this differs from `SignedInChrome`'s own
        // `OrganizationSwitcher` in the identical slot.
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
