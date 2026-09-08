/**
 * `components/AppShell.tsx` (WEB-29): the drawer's own closing lifecycle —
 * `pages/Shell.tsx`'s own `shell.test.tsx` exercises the drawer through the
 * shell's real nav items, but these two behaviours are properties of
 * `AppShell` itself, not of anything `Shell.tsx` decides, so they are
 * pinned here directly rather than indirectly through a shell fixture.
 *
 * Coordinator review findings (round 2 of the WEB-29/WEB-30 review):
 *
 *  1. `transitionend` bubbles, and every `Button` inside the drawer carries
 *     its own `transition-colors` (`Button.tsx`) — an unrelated hover-color
 *     transition finishing (the close button, sign-out) must not be
 *     mistaken for the drawer's own translate finishing.
 *  2. `prefers-reduced-motion: reduce` collapses the drawer's own
 *     transition to `0ms`, and a `0ms` CSS transition fires no
 *     `transitionend` at all — the closing effect must not wait on one that
 *     will never come, or a reduced-motion caller is left with an inert
 *     document for the full `DRAWER_TRANSITION_MS` after the drawer is
 *     already visually gone.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from '../src/components/AppShell.js'

function renderShell() {
  return render(
    <AppShell
      navGroups={[
        {
          key: 'everyday',
          items: [
            { key: 'chat', label: 'Chat', onClick: vi.fn(), active: false },
          ],
        },
      ]}
      onHome={vi.fn()}
      headerStart={null}
      headerEnd={null}
      drawerFooter={null}
    >
      <div>content</div>
    </AppShell>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AppShell drawer closing (WEB-29, coordinator review round 2)', () => {
  it('a transitionend from a control inside the drawer (not the dialog itself) does not close it early', () => {
    renderShell()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Navigation' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Close navigation menu' })
    )

    // The close button's own `transition-colors` (Button.tsx) finishing —
    // simulated directly, targeted at the button, not the dialog — bubbles
    // up through the dialog exactly the way a real hover-color transition
    // would. Without the `event.target !== dialog` filter, this alone would
    // call `dialog.close()`, cutting the drawer's own 200ms slide short.
    fireEvent.transitionEnd(
      screen.getByRole('button', { name: 'Close navigation menu' })
    )
    expect(dialog).toBeVisible()

    // The dialog's own transitionend — the real one — still closes it.
    fireEvent.transitionEnd(dialog)
    expect(dialog).not.toBeVisible()
  })

  it('under prefers-reduced-motion, closing does not wait out the timeout fallback — the reduced-motion transition never fires transitionend at all', () => {
    // `window.matchMedia('(prefers-reduced-motion: reduce)').matches` —
    // the same query `motion-reduce:duration-0` (AppShell.tsx's own
    // className) keys off, read directly rather than guessed at.
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    )

    renderShell()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Navigation' })
    fireEvent.click(
      screen.getByRole('button', { name: 'Close navigation menu' })
    )

    // Closed immediately — no `transitionend`, and no timer advanced —
    // because a `0ms` transition was never going to fire one. Before this
    // fix, only `DRAWER_TRANSITION_MS`'s own timeout closed it, leaving the
    // native `<dialog>` (and the inertness it imposes on the rest of the
    // document) live for the full 200ms after the drawer had already
    // visually vanished.
    expect(dialog).not.toBeVisible()
  })
})
