/**
 * WEB-32/WEB-34: the one place this app reads or writes browser history —
 * `App.tsx` calls this once, at the top, and threads `route`/`navigate`
 * down as props to whatever the parsed route needs to reach
 * (`pages/Shell.tsx`, `pages/ProjectsPanel.tsx`, `pages/Chat.tsx`), the same
 * "one owner, threaded as props" shape this app already holds itself to
 * for session state (`App.tsx`'s own `session`) rather than a second
 * context alongside `hooks/navigation-guard.tsx`'s.
 *
 * `navigate` pushes a new history entry by default — an ordinary,
 * back-button-reachable navigation — and only replaces the current one when
 * asked (`{ replace: true }`), for the handful of places WEB-34 states
 * explicitly must never be navigated back into: the home route's own
 * resolution to a real landing screen, and the five entry points
 * `App.tsx`'s own module comment already lists (a sign-in redemption, a
 * Discord callback, and the rest).
 */

import { useCallback, useEffect, useState } from 'react'

import { buildPath, parseRoute, type Route } from './route.js'

export interface UseRouteResult {
  route: Route
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

export function useRoute(): UseRouteResult {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname)
  )

  // The browser's own back/forward buttons change `window.location`
  // without this app ever calling `navigate` — `popstate` is the one event
  // that fires when they do, so this is the only way `route` can ever
  // change to something this hook did not itself just push or replace.
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback(
    (next: Route, options?: { replace?: boolean }) => {
      const path = buildPath(next)
      if (options?.replace) {
        window.history.replaceState(null, '', path)
      } else {
        window.history.pushState(null, '', path)
      }
      // `pushState`/`replaceState` change the address bar but fire no event
      // of their own (only a *user-driven* history change fires `popstate`
      // — this app already relied on that same fact for the histories it
      // has written by hand since before this slice, `App.tsx`'s own former
      // `setPath` calls alongside every `replaceState`) — so `route` state
      // has to be set here explicitly too.
      setRoute(next)
    },
    []
  )

  return { route, navigate }
}
