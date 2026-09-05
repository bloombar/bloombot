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

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  hasNavigationGuard,
  runGuardedNavigation,
} from '../hooks/navigation-guard.js'
import { buildPath, parseRoute, type Route } from './route.js'

export interface UseRouteResult {
  route: Route
  navigate: (route: Route, options?: { replace?: boolean }) => void
}

export function useRoute(): UseRouteResult {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname)
  )

  // The address this hook believes it is on — read by the `popstate`
  // handler below, which has to be able to put the address *back* before
  // asking a dirty form whether the navigation may proceed. A ref rather
  // than state: nothing renders from it, and the handler must see the
  // current value rather than one closed over at registration time.
  const currentPathRef = useRef(window.location.pathname)

  // The browser's own back/forward buttons change `window.location`
  // without this app ever calling `navigate` — `popstate` is the one event
  // that fires when they do, so this is the only way `route` can ever
  // change to something this hook did not itself just push or replace.
  //
  // WEB-34/WEB-16 — a `popstate` is a navigation like any other, so a dirty
  // form gets its say before it is honoured. This is not the pre-existing
  // gap `docs/DECISIONS.md` D-78 first recorded it as: before the panel had
  // addresses at all it pushed no history entries, so Back left the
  // *document* and the `beforeunload` handler `hooks/useUnsavedChangesGuard.ts`
  // registers while dirty produced the browser's own native "leave site?"
  // prompt. Making Back an in-app navigation removed that prompt and put
  // nothing in its place, which is a regression this slice introduced and
  // this handler closes.
  //
  // The browser has already moved by the time `popstate` fires, so the
  // order here is: put the address back where it was (`pushState`, so the
  // screen on display and the address bar agree while the confirmation is
  // open), ask, and only then honour the move. Answering "keep editing"
  // therefore leaves the panel exactly where it was; answering "discard"
  // pushes the destination rather than popping to it, which costs one
  // history entry and keeps every address correct — the alternative,
  // `history.back()` after the guard resolves, would fire this same handler
  // a second time and ask again.
  useEffect(() => {
    const onPopState = () => {
      const nextPath = window.location.pathname
      if (!hasNavigationGuard()) {
        currentPathRef.current = nextPath
        setRoute(parseRoute(nextPath))
        return
      }
      window.history.pushState(null, '', currentPathRef.current)
      runGuardedNavigation(() => {
        window.history.pushState(null, '', nextPath)
        currentPathRef.current = nextPath
        setRoute(parseRoute(nextPath))
      })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback(
    (next: Route, options?: { replace?: boolean }) => {
      const path = buildPath(next)
      // A navigation to the address already on screen is not a navigation
      // (review finding): every drawer item stays clickable while it is the
      // active one, and the home control is clickable while already home,
      // so pushing here stacked an identical entry per click and left Back
      // apparently inert for as many presses as the person had made. Still
      // sets `route` below on a `replace`, which callers use to *correct* an
      // address rather than to move.
      if (path === currentPathRef.current && !options?.replace) return
      currentPathRef.current = path
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
