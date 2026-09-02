/**
 * WEB-16: `useFormDirty` (value comparison, not keystroke counting) and
 * `useUnsavedChangesGuard`'s own `beforeunload` registration — the one
 * case `Modal.tsx` cannot cover at all (`docs/DECISIONS.md` has the full
 * reasoning): a browser's own native prompt, registered only while the
 * form is actually dirty.
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ModalProvider } from '../src/components/modal/ModalProvider.js'
import { NavigationGuardProvider } from '../src/hooks/navigation-guard.js'
import { useFormDirty } from '../src/hooks/useFormDirty.js'
import { useUnsavedChangesGuard } from '../src/hooks/useUnsavedChangesGuard.js'

describe('useFormDirty (WEB-16)', () => {
  it('is false when current equals baseline', () => {
    let isDirty: boolean | undefined
    function Harness() {
      isDirty = useFormDirty({ title: 'A' }, { title: 'A' })
      return null
    }
    render(<Harness />)
    expect(isDirty).toBe(false)
  })

  it('is true once a field differs', () => {
    let isDirty: boolean | undefined
    function Harness() {
      isDirty = useFormDirty({ title: 'A' }, { title: 'B' })
      return null
    }
    render(<Harness />)
    expect(isDirty).toBe(true)
  })

  it('a value changed and then reverted compares clean again — this hook never remembers history, only the current value', () => {
    let isDirty: boolean | undefined
    function Harness({ current }: { current: string }) {
      isDirty = useFormDirty({ title: 'A' }, { title: current })
      return null
    }
    const { rerender } = render(<Harness current="B" />)
    expect(isDirty).toBe(true)
    rerender(<Harness current="A" />)
    expect(isDirty).toBe(false)
  })
})

function GuardHarness({ isDirty }: { isDirty: boolean }) {
  useUnsavedChangesGuard(isDirty)
  return null
}

describe('useUnsavedChangesGuard (WEB-16): beforeunload', () => {
  it('registers a beforeunload handler only while dirty', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const { rerender, unmount } = render(
      <ModalProvider>
        <NavigationGuardProvider>
          <GuardHarness isDirty={false} />
        </NavigationGuardProvider>
      </ModalProvider>
    )
    expect(addSpy.mock.calls.some(([type]) => type === 'beforeunload')).toBe(
      false
    )

    rerender(
      <ModalProvider>
        <NavigationGuardProvider>
          <GuardHarness isDirty={true} />
        </NavigationGuardProvider>
      </ModalProvider>
    )
    expect(addSpy.mock.calls.some(([type]) => type === 'beforeunload')).toBe(
      true
    )

    rerender(
      <ModalProvider>
        <NavigationGuardProvider>
          <GuardHarness isDirty={false} />
        </NavigationGuardProvider>
      </ModalProvider>
    )
    // Clean again — the handler registered while dirty is removed, not
    // left behind to fire a native prompt over a form with nothing to
    // lose (WEB-16's own "a clean form leaves with no prompt").
    expect(removeSpy.mock.calls.some(([type]) => type === 'beforeunload')).toBe(
      true
    )

    unmount()
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('the beforeunload handler calls preventDefault (the one lever that asks the browser to show its own prompt)', () => {
    let capturedHandler: ((event: Event) => void) | undefined
    vi.spyOn(window, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'beforeunload') {
          capturedHandler = listener as (event: Event) => void
        }
      }
    )

    render(
      <ModalProvider>
        <NavigationGuardProvider>
          <GuardHarness isDirty={true} />
        </NavigationGuardProvider>
      </ModalProvider>
    )

    expect(capturedHandler).toBeDefined()
    const event = new Event('beforeunload', { cancelable: true })
    capturedHandler?.(event)
    expect(event.defaultPrevented).toBe(true)

    vi.restoreAllMocks()
  })
})
