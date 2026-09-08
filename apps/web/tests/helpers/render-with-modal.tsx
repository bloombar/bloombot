/**
 * Test helper: render a component wrapped in `ModalProvider` and
 * `NavigationGuardProvider` — every test for a component that calls
 * `useModal()` or `useUnsavedChangesGuard()`/`useNavigationGuard()`
 * (`components/modal/ModalProvider.js`, `hooks/navigation-guard.js`) needs
 * both in the tree, the same way `main.tsx`/`pages/Shell.tsx` mount one of
 * each for the whole app. A bare `render()` throws the moment such a
 * component mounts with no provider above it — wrapping in both,
 * unconditionally, is simpler than each test file deciding which one its
 * own component actually needs.
 */

import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'

import { ModalProvider } from '../../src/components/modal/ModalProvider.js'
import { NavigationGuardProvider } from '../../src/hooks/navigation-guard.js'

/** The wrapping itself, exported separately so a test's own `rerender(...)` call — which replaces the whole tree it was given, providers included — can rewrap a new element the same way rather than accidentally unmounting both providers. */
export function withModal(ui: ReactElement): ReactElement {
  return (
    <ModalProvider>
      <NavigationGuardProvider>{ui}</NavigationGuardProvider>
    </ModalProvider>
  )
}

export function renderWithModal(ui: ReactElement): RenderResult {
  return render(withModal(ui))
}
