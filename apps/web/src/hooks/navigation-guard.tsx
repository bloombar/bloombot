/**
 * WEB-16: lets a dirty form (`pages/CourseEditor.tsx`, via
 * `useUnsavedChangesGuard` below) intercept a navigation that starts
 * somewhere it does not own — the hamburger menu, a nav link, the home
 * icon (`pages/Shell.tsx`'s own `navItems`/`onHome`, `components/AppShell.tsx`) —
 * without `Shell.tsx` needing to know anything about which of its nested
 * pages might currently be a dirty form. One `NavigationGuardProvider`
 * wraps the shell (`pages/Shell.tsx`); the form registers a guard while it
 * is dirty and clears it the moment it is not (unmounting, saving, or the
 * values reverting to their baseline).
 *
 * The registration is a plain ref, not state (`registerGuard` below never
 * triggers a re-render) — nothing here is rendered *from* the current
 * guard, it is only ever *called*, so state would only add renders no
 * screen needs.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'

interface NavigationGuardContextValue {
  /** Called by a form while it is dirty, with a function that resolves `true` to allow the navigation or `false` to block it — and with `null` once the form is clean or unmounts. */
  registerGuard: (guard: (() => Promise<boolean>) | null) => void
  /** Called by anything that navigates within the shell — runs `action` immediately when nothing is registered, or after the registered guard resolves `true`. */
  guardedNavigate: (action: () => void) => void
}

const NavigationGuardContext = createContext<
  NavigationGuardContextValue | undefined
>(undefined)

/**
 * WEB-34 — the same registered guard, reachable *without* the context.
 *
 * `routing/useRoute.ts` has to consult it from a `popstate` handler, and
 * `popstate` is the one navigation this app does not start: the browser has
 * already moved by the time anything here hears about it. `useRoute` is
 * also called by `App.tsx`, which renders the provider *below* itself
 * (`pages/Shell.tsx` is what wraps the shell in one), so the hook cannot
 * read the context at all — it sits above it in the tree.
 *
 * A module-level mirror of `guardRef` closes that gap without a second
 * provider or a context this app would have to hoist for one caller. It is
 * written only by the provider, cleared when that provider unmounts (so a
 * test's own render never leaves a guard armed for the next one), and read
 * only by `runGuardedNavigation` below.
 */
let activeGuard: (() => Promise<boolean>) | null = null

/** WEB-34 — is a dirty form currently registered? `routing/useRoute.ts` asks before it lets a `popstate` through, so a clean panel pays nothing for this path. */
export function hasNavigationGuard(): boolean {
  return activeGuard !== null
}

/** WEB-34 — `guardedNavigate` for a caller that cannot reach the context (`routing/useRoute.ts`'s `popstate` handler). Identical semantics: run `action` immediately when nothing is registered, otherwise only if the registered guard resolves `true`. */
export function runGuardedNavigation(action: () => void): void {
  const guard = activeGuard
  if (!guard) {
    action()
    return
  }
  void guard().then((proceed) => {
    if (proceed) action()
  })
}

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guardRef = useRef<(() => Promise<boolean>) | null>(null)

  const registerGuard = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      guardRef.current = guard
      activeGuard = guard
    },
    []
  )

  // Clear the module-level mirror when this provider goes away — a test
  // that renders a dirty form and unmounts it must not leave the next test
  // (or, in the app, a re-mounted shell) with a guard nothing owns.
  useEffect(() => {
    return () => {
      activeGuard = null
    }
  }, [])

  const guardedNavigate = useCallback((action: () => void) => {
    const guard = guardRef.current
    if (!guard) {
      action()
      return
    }
    void guard().then((proceed) => {
      if (proceed) action()
    })
  }, [])

  return (
    <NavigationGuardContext value={{ registerGuard, guardedNavigate }}>
      {children}
    </NavigationGuardContext>
  )
}

/** `pages/Shell.tsx`'s own side — wrap every navigation callback it hands to `AppShell`/`OrganizationSwitcher` in `guardedNavigate`. */
export function useNavigationGuard(): NavigationGuardContextValue {
  const context = useContext(NavigationGuardContext)
  if (!context) {
    throw new Error(
      'useNavigationGuard() must be used inside a <NavigationGuardProvider>'
    )
  }
  return context
}
