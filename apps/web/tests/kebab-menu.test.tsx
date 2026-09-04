/**
 * `components/KebabMenu.tsx` (WEB-26/WEB-17): a real menu — reachable and
 * operable by keyboard, closed by `Escape` and by clicking away, and
 * labelled by the row it acts on.
 */

import { screen, fireEvent, render } from '@testing-library/react'
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
      screen.queryByRole('menu', { name: 'Actions for "Fall 2026"' })
    ).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', {
      name: 'Actions for "Fall 2026"',
    })

    fireEvent.click(trigger)

    expect(
      screen.getByRole('menu', { name: 'Actions for "Fall 2026"' })
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

    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))

    expect(onDuplicate).toHaveBeenCalledTimes(1)
    expect(onArchive).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
