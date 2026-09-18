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

describe('AppShell drawer backdrop click (WEB-60)', () => {
  it('a click on the backdrop closes the drawer, the same path Escape takes', async () => {
    renderShell()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Navigation' })
    expect(dialog).toBeVisible()

    // A backdrop click's own event has no element to land on but the
    // `<dialog>` itself — firing the click directly at it is exactly that
    // case (this file's own `onClick` comment on `AppShell.tsx`).
    fireEvent.click(dialog)
    fireEvent.transitionEnd(dialog)

    expect(dialog).not.toBeVisible()
  })

  it('a click on something inside the drawer does not close it', () => {
    renderShell()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Navigation' })

    // The "Menu" title bar — inert, but still a descendant of the dialog,
    // not the dialog itself.
    fireEvent.click(screen.getByText('Menu'))

    expect(dialog).toBeVisible()
  })

  // WEB-16/WEB-29 — a click on a nav item must not close the drawer by
  // itself (`AppShellHandle`'s own doc comment on `AppShell.tsx`: that is
  // `item.onClick`'s own job, once its own guarded navigation actually
  // proceeds, not this component's). The backdrop-click handler must not
  // second-guess that: `event.target` for a click on the item is the
  // item's own button, never `event.currentTarget` (the dialog), so the
  // branch this slice added never fires here — the same "descendant, not
  // the dialog itself" case the "does not close" test above already pins,
  // exercised again on a real nav item rather than inert title text.
  it('a click on a nav item does not close the drawer through the new backdrop path (its own onClick still owns closing)', () => {
    renderShell()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Navigation' })

    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))

    expect(dialog).toBeVisible()
  })

  it('Escape still closes the drawer, unaffected by the backdrop click handler', () => {
    renderShell()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open navigation menu' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Navigation' })

    // jsdom does not dispatch a real `cancel` event for an actual Escape
    // keypress on a `<dialog>` — the browser's own default is simulated
    // directly, the same event `onCancel` (`AppShell.tsx`) already handles.
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    fireEvent.transitionEnd(dialog)

    expect(dialog).not.toBeVisible()
  })
})

describe('AppShell footer support link', () => {
  it('mails bloombot@wonkledge.com, not the old placeholder address', () => {
    renderShell()

    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute(
      'href',
      'mailto:bloombot@wonkledge.com'
    )
  })
})
