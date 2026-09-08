/**
 * WEB-16: the primitive `useUnsavedChangesGuard`/`pages/CourseEditor.tsx`
 * build on — a form registers a guard while dirty; anything that
 * navigates elsewhere in the shell (`pages/Shell.tsx`'s own nav row, home
 * control, and organization switcher, none of which know anything about
 * whatever nested form might currently be dirty) calls `guardedNavigate`,
 * which asks the registered guard first. The real, in-app "click the
 * hamburger menu while a form is dirty" case is `e2e/keyboard.spec.ts`'s
 * own scenario (that spec covers both the keyboard path and the in-app
 * navigation guard together — its own module comment explains why),
 * against a real browser — this file is the primitive itself, isolated
 * from any real page.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  NavigationGuardProvider,
  useNavigationGuard,
} from '../src/hooks/navigation-guard.js'

function Harness({
  guardResult,
  onNavigated,
}: {
  guardResult: boolean
  onNavigated: () => void
}) {
  const { registerGuard, guardedNavigate } = useNavigationGuard()
  return (
    <div>
      <button
        type="button"
        onClick={() => registerGuard(() => Promise.resolve(guardResult))}
      >
        register dirty guard
      </button>
      <button type="button" onClick={() => registerGuard(null)}>
        clear guard
      </button>
      <button type="button" onClick={() => guardedNavigate(onNavigated)}>
        navigate
      </button>
    </div>
  )
}

describe('NavigationGuardProvider (WEB-16)', () => {
  it('with no guard registered, navigation runs immediately', () => {
    const onNavigated = vi.fn()
    render(
      <NavigationGuardProvider>
        <Harness guardResult={false} onNavigated={onNavigated} />
      </NavigationGuardProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }))
    expect(onNavigated).toHaveBeenCalledTimes(1)
  })

  it('a registered guard that resolves false blocks the navigation', async () => {
    const onNavigated = vi.fn()
    render(
      <NavigationGuardProvider>
        <Harness guardResult={false} onNavigated={onNavigated} />
      </NavigationGuardProvider>
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'register dirty guard' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }))

    // Give the guard's own promise a tick to resolve — it never should
    // result in a call either way, but this proves the assertion is not
    // just racing an unresolved promise.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onNavigated).not.toHaveBeenCalled()
  })

  it('a registered guard that resolves true allows the navigation', async () => {
    const onNavigated = vi.fn()
    render(
      <NavigationGuardProvider>
        <Harness guardResult={true} onNavigated={onNavigated} />
      </NavigationGuardProvider>
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'register dirty guard' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }))

    await waitFor(() => expect(onNavigated).toHaveBeenCalledTimes(1))
  })

  it('clearing the guard (the form became clean, or unmounted) lets navigation run immediately again', () => {
    const onNavigated = vi.fn()
    render(
      <NavigationGuardProvider>
        <Harness guardResult={false} onNavigated={onNavigated} />
      </NavigationGuardProvider>
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'register dirty guard' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'clear guard' }))
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }))
    expect(onNavigated).toHaveBeenCalledTimes(1)
  })
})
