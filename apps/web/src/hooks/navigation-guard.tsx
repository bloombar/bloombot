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

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guardRef = useRef<(() => Promise<boolean>) | null>(null)

  const registerGuard = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      guardRef.current = guard
    },
    []
  )

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
