/**
 * `components/KebabMenu.tsx` (WEB-26/WEB-17): a real menu — reachable and
 * operable by keyboard, closed by `Escape` and by clicking away, labelled
 * by the row it acts on, and never more than one open at once.
 */

import { screen, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KebabMenu } from '../src/components/KebabMenu.js'

afterEach(() => {
  vi.resetAllMocks()
})

describe('KebabMenu (WEB-26)', () => {
  it('is closed until its own trigger is activated, and names the row it acts on', () => {
    render(
      <KebabMenu
        label='Actions for "Fall 2026"'
        items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
      />
    )

    expect(
      screen.queryByRole('group', { name: 'Actions for "Fall 2026"' })
    ).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', {
      name: 'Actions for "Fall 2026"',
    })

    fireEvent.click(trigger)

    expect(
      screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    ).toBeInTheDocument()
  })

  it("activating an item closes the menu and calls its own onSelect, not another item's", () => {
    const onArchive = vi.fn()
    const onDuplicate = vi.fn()
    render(
      <KebabMenu
        label='Actions for "Fall 2026"'
        items={[
          { key: 'archive', label: 'Archive', onSelect: onArchive },
          { key: 'duplicate', label: 'Duplicate', onSelect: onDuplicate },
        ]}
      />
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for "Fall 2026"' })
    )
    const group = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })

    fireEvent.click(within(group).getByRole('button', { name: 'Duplicate' }))

    expect(onDuplicate).toHaveBeenCalledTimes(1)
    expect(onArchive).not.toHaveBeenCalled()
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  // Cheap-fix 3 (round 1 review): activating an item must not strand focus
  // on `<body>` — the just-activated `<button>` is removed from the DOM
  // the instant the popup closes, so focus has to be moved back to the
  // trigger *before* `onSelect` runs, the same discipline the `Escape`
  // path below already holds itself to. Matters most for an item whose
  // own `onSelect` opens `Modal.tsx`'s own prompt/confirm dialog: that
  // dialog restores focus to whatever was focused when it opened, once it
  // closes — `<body>`, without this fix, not the kebab's own trigger.
  it('activating an item returns focus to the trigger, not to <body>', () => {
    const onSelect = vi.fn()
    render(
      <KebabMenu
        label='Actions for "Fall 2026"'
        items={[{ key: 'archive', label: 'Archive', onSelect }]}
      />
    )
    const trigger = screen.getByRole('button', {
      name: 'Actions for "Fall 2026"',
    })
    fireEvent.click(trigger)
    const group = screen.getByRole('group', { name: 'Actions for "Fall 2026"' })

    fireEvent.click(within(group).getByRole('button', { name: 'Archive' }))

    expect(trigger).toHaveFocus()
  })

  // WEB-17: `Escape` closes the menu and returns focus to the control that
  // opened it — a hand-built popup has to reproduce this itself, unlike a
  // native `<dialog>` (`components/modal/Modal.tsx`), which gets it for
  // free.
  it('Escape closes the menu and returns focus to its own trigger', () => {
    render(
      <KebabMenu
        label='Actions for "Fall 2026"'
        items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
      />
    )
    const trigger = screen.getByRole('button', {
      name: 'Actions for "Fall 2026"',
    })
    fireEvent.click(trigger)
    expect(screen.getByRole('group')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  // WEB-17: a click anywhere outside the menu also closes it — the same
  // "clicking away dismisses a transient surface" behaviour a native
  // `<select>` already gives for free.
  it('a click outside the menu closes it', () => {
    render(
      <div>
        <button type="button">Elsewhere</button>
        <KebabMenu
          label='Actions for "Fall 2026"'
          items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
        />
      </div>
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for "Fall 2026"' })
    )
    expect(screen.getByRole('group')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }))

    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  // WEB-26: six identical kebabs in a list must stay distinguishable — the
  // `aria-label` names the row, not merely "Actions."
  it('two menus for two different rows carry two different accessible names', () => {
    render(
      <div>
        <KebabMenu
          label='Actions for "Fall 2026"'
          items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
        />
        <KebabMenu
          label='Actions for "Spring 2027"'
          items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
        />
      </div>
    )

    expect(
      screen.getByRole('button', { name: 'Actions for "Fall 2026"' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Actions for "Spring 2027"' })
    ).toBeInTheDocument()
  })

  // Round 1 review finding: a `mousedown`-only outside-click listener
  // closes a sibling menu on a *pointer* click, but a keyboard activation
  // (`Enter`/`Space`, which `fireEvent.click` below stands in for — both
  // fire the same `click` event a real keyboard activation does) fires no
  // `mousedown` at all, so a second kebab opened by keyboard used to leave
  // the first one open too.
  it('opening a second kebab menu closes the first, even without a pointer event', () => {
    render(
      <div>
        <KebabMenu
          label='Actions for "Fall 2026"'
          items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
        />
        <KebabMenu
          label='Actions for "Spring 2027"'
          items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
        />
      </div>
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for "Fall 2026"' })
    )
    expect(
      screen.getByRole('group', { name: 'Actions for "Fall 2026"' })
    ).toBeInTheDocument()

    // A plain `click` — no `mousedown` fired first, the same event shape a
    // keyboard `Enter`/`Space` activation of a `<button>` produces.
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for "Spring 2027"' })
    )

    expect(
      screen.queryByRole('group', { name: 'Actions for "Fall 2026"' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: 'Actions for "Spring 2027"' })
    ).toBeInTheDocument()
  })

  it('a disabled menu cannot be opened', () => {
    render(
      <KebabMenu
        label='Actions for "Fall 2026"'
        items={[{ key: 'archive', label: 'Archive', onSelect: vi.fn() }]}
        disabled
      />
    )

    const trigger = screen.getByRole('button', {
      name: 'Actions for "Fall 2026"',
    })
    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })
})
