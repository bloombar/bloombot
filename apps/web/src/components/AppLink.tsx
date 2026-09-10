/**
 * WEB-41: a real `<a>` for every in-app destination that used to be a
 * `<button onClick={() => navigate(...)}>` — this app has no router
 * (`routing/route.ts`'s own module comment on why), so nothing in it had
 * ever rendered a genuine internal link before this slice; the only
 * `<a href>`s anywhere in `apps/web` were `/privacy` and `/terms`
 * (`components/legal-links.ts`), which are real full-page loads on
 * purpose. This component is the one place that changes: a real `href`
 * (built with `buildPath`, never a hand-concatenated string — the same
 * discipline every other caller of `routing/route.ts` already holds
 * itself to) so the address is visible on hover and "copy link" works,
 * but an ordinary click still does client-side navigation rather than a
 * reload.
 *
 * The one thing this component exists to get right: a *modified* click —
 * cmd/ctrl-click, shift-click, alt-click, or a non-primary mouse button
 * (middle-click) — must fall through to the browser untouched, so "open in
 * a new tab" keeps working exactly as it would for any other link on the
 * web. `preventDefault()` (and the `navigate` call it guards) only run for
 * a plain, unmodified, primary-button click; every other click is left
 * alone.
 */

import type { MouseEvent, ReactNode } from 'react'

import { buildPath, type Route } from '../routing/route.js'

export interface AppLinkProps {
  /** The destination, as a typed `Route` rather than a hand-built string — a bad destination is then a type error, not a silent broken link. */
  to: Route
  /** `routing/useRoute.ts`'s own `navigate`, threaded down the same way every other in-app navigation already is (no context, no global) — the caller passes whatever `navigate` it already has in scope. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  className?: string
  children?: ReactNode
}

export function AppLink({ to, navigate, className, children }: AppLinkProps) {
  const href = buildPath(to)
  return (
    <a
      href={href}
      className={className}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        // A modified click, or a click from any button but the primary
        // one, is left alone — this is the whole reason an anchor is used
        // here instead of a button (this file's own module comment).
        // `button !== 0` covers a middle-click (button 1) opening a new
        // tab, the same way a right-click's own context menu is untouched
        // because it never reaches a `click` handler at all.
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return
        }
        event.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
