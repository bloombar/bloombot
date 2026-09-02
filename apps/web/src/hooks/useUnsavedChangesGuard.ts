/**
 * WEB-16: the reusable "are you sure you want to leave" behaviour every
 * form in this panel needs, built once here rather than per form. Given
 * whether a form is currently dirty (`useFormDirty`), this hook:
 *
 *  1. Registers a guard with `useNavigationGuard()` so an *in-app*
 *     navigation that starts outside the form (the hamburger menu, a nav
 *     link, the home icon) is intercepted and asks first — the same
 *     confirm dialog `confirmDiscard` exposes for the form's own Cancel
 *     button to call directly.
 *  2. Registers a `beforeunload` handler, but **only while dirty** — a
 *     browser fires its *own* native prompt for this, worded by the
 *     browser and not by this app; nothing here can replace it with the
 *     shared `Modal.tsx`, since the moment `beforeunload` fires the page
 *     is already tearing down and no React state update, dialog render or
 *     `await` can happen before it finishes — the handler's only lever is
 *     `event.preventDefault()`, which is what asks the browser to show its
 *     own prompt at all. Registered only while dirty (not unconditionally,
 *     and cleared the instant the form becomes clean) so leaving an
 *     untouched form is silent (WEB-16's own "a clean form leaves with no
 *     prompt" — see `docs/DECISIONS.md`).
 *
 * `confirmDiscard()` is returned so a form's own Cancel/Close control can
 * call the *exact* same check and the *exact* same dialog wording the
 * cross-component navigation guard uses — one confirmation, reachable two
 * ways, not two.
 */

import { useCallback, useEffect } from 'react'

import { useNavigationGuard } from './navigation-guard.js'
import { useModal } from '../components/modal/ModalProvider.js'

export interface UnsavedChangesGuard {
  /** Resolves `true` when it is safe to proceed (the form was clean, or the person confirmed discarding), `false` when they chose to keep editing. */
  confirmDiscard: () => Promise<boolean>
}

export function useUnsavedChangesGuard(isDirty: boolean): UnsavedChangesGuard {
  const { confirm } = useModal()
  const { registerGuard } = useNavigationGuard()

  const confirmDiscard = useCallback(async () => {
    if (!isDirty) return true
    return confirm({
      title: 'Discard unsaved changes?',
      description:
        'Your changes have not been saved. Leaving now discards them.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      destructive: true,
    })
  }, [isDirty, confirm])

  useEffect(() => {
    registerGuard(isDirty ? confirmDiscard : null)
    // Unregister on unmount (navigating away by some route this hook did
    // not itself guard — e.g. the form's own `onSaved` — must not leave a
    // stale guard blocking whatever the person does next) and whenever
    // `isDirty`/`confirmDiscard` change, so the registered function is
    // never a stale closure over an earlier `isDirty`.
    return () => registerGuard(null)
  }, [isDirty, confirmDiscard, registerGuard])

  useEffect(() => {
    if (!isDirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Legacy convention some browsers still read instead of (or as well
      // as) `preventDefault()` — `exactOptionalPropertyTypes` is fine with
      // this since `returnValue` is declared as a plain `string`, not
      // optional.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  return { confirmDiscard }
}
