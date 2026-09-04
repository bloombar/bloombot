/**
 * WEB-26: the row-level overflow menu — shared by `pages/Projects.tsx` and
 * `pages/Courses.tsx` (WEB-17: one real menu implementation, not a
 * bespoke popup grown separately on each screen the way `pages/Projects.tsx`'s
 * old per-row Archive button and free-text "duplicate as" input used to be).
 *
 * A real menu, per WEB-17/WEB-26 — "real" here meaning genuinely reachable
 * and operable by keyboard, not merely *labelled* as an ARIA menu:
 *  - opened from one control (a ghost `Button`, the kebab glyph from
 *    `icons.ts`), reachable by `Tab` like any other control on the page;
 *  - `Escape` closes it and returns focus to the control that opened it,
 *    rather than leaving focus stranded inside a menu that no longer
 *    exists;
 *  - a click anywhere outside it also closes it — the same "clicking away
 *    dismisses a transient surface" behaviour a native `<select>` already
 *    gives for free, which this hand-built popup has to reproduce itself;
 *  - only one is ever open at a time — opening a second one (by mouse
 *    *or* by keyboard: `Enter`/`Space` on its own trigger fires the same
 *    `click` event a pointer does) closes any other still open, broadcast
 *    through `KEBAB_MENU_OPEN_EVENT` below rather than through some shared
 *    "which menu is open" owner this component has no natural place to
 *    put (round 1 review finding: a `mousedown`-only outside-click
 *    listener caught a mouse click on a second kebab, but not a keyboard
 *    activation of one, so two could be open at once);
 *  - `aria-label` names *which row* this menu acts on (e.g. `Actions for
 *    "Fall 2026"`), not merely "Actions" — WEB-26's own worked example: six
 *    identical kebabs in a list read identically to a screen reader
 *    otherwise.
 *
 * Deliberately **not** `role="menu"`/`role="menuitem"` (round 1 review
 * finding, corrected here): those roles promise a keyboard contract this
 * component does not implement — `ArrowDown`/`ArrowUp`/`Home`/`End`
 * navigation, focus moved into the popup on open, typeahead — and a
 * screen reader announcing "menu" for a widget that does not behave like
 * one is worse than not claiming the role at all. Every item here is an
 * ordinary, independently-focusable `<button>`, reached the same way any
 * other run of buttons on the page is: `Tab` through them one at a time.
 * The popup itself carries `role="group"` with the same row-naming
 * `aria-label`, honest about what it actually is — a labelled group of
 * buttons, not a menu widget.
 *
 * Items may be `destructive`-styled (WEB-15's own danger palette, applied
 * per item rather than to the whole menu, since a menu mixing an ordinary
 * action like Rename with a destructive one like Archive is exactly what
 * WEB-26 asks this component to hold).
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { Button } from './Button.js'
import { KebabIcon } from '../icons.js'

export interface KebabMenuItem {
  key: string
  label: string
  /** A Lucide icon component (from `icons.ts`), shown before the label — `aria-hidden`, matching `Button.tsx`'s own convention (the label already carries the meaning). */
  icon?: ReactNode
  onSelect: () => void
  /** WEB-15's danger palette for this one item, not the whole menu. */
  destructive?: boolean
  disabled?: boolean
}

export interface KebabMenuProps {
  /** Names the row this menu acts on, e.g. `Actions for "Fall 2026"` — this file's own module comment on why. */
  label: string
  items: KebabMenuItem[]
  /** Disables the trigger itself — a row mid-mutation (an archive, a rename) offers no way to start a second one on top of it, the same guard every other busy control in this panel already applies to itself. */
  disabled?: boolean
}

/** Broadcast on `window` the instant any `KebabMenu` opens, carrying its own `useId()` — every *other* mounted instance closes itself on hearing one that is not its own (this file's own module comment on why). */
const KEBAB_MENU_OPEN_EVENT = 'bloombot:kebab-menu-open'

export function KebabMenu({ label, items, disabled }: KebabMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  // Round 1 review finding: only one kebab menu open at a time, including
  // when a second one is opened by keyboard, not only by a pointer click —
  // this file's own module comment above has the full reasoning. Listens
  // unconditionally (not only while `open`), since this instance itself
  // might be the one about to be told to close.
  useEffect(() => {
    function handleOtherMenuOpened(event: Event) {
      const openedId = (event as CustomEvent<string>).detail
      if (openedId !== id) setOpen(false)
    }
    window.addEventListener(KEBAB_MENU_OPEN_EVENT, handleOtherMenuOpened)
    return () =>
      window.removeEventListener(KEBAB_MENU_OPEN_EVENT, handleOtherMenuOpened)
  }, [id])

  // WEB-26/WEB-17: `Escape` and "click away" both close the menu — neither
  // is a browser default for a hand-built popup the way it would be for a
  // native `<dialog>` (`components/modal/Modal.tsx`) or `<select>`, so both
  // are wired here, once, rather than left to each call site to remember.
  useEffect(() => {
    if (!open) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      // Focus returns to the control that opened the menu — the same
      // "never leave focus stranded" discipline `Modal.tsx`'s own native
      // `<dialog>` gets from the browser for free; this hand-built popup
      // has to do it itself.
      buttonRef.current?.focus()
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <Button
        ref={buttonRef}
        variant="ghost"
        aria-label={label}
        aria-expanded={open}
        icon={<KebabIcon aria-hidden="true" className="size-4" />}
        onClick={() => {
          setOpen((current) => {
            const next = !current
            // Only announced on the way *open* — closing this instance
            // (mouse, `Escape`, an item activating) has no sibling menu to
            // tell anything to.
            if (next) {
              window.dispatchEvent(
                new CustomEvent(KEBAB_MENU_OPEN_EVENT, { detail: id })
              )
            }
            return next
          })
        }}
        disabled={disabled}
      />
      {open && (
        <div
          role="group"
          aria-label={label}
          className="absolute right-0 z-10 mt-1 flex min-w-40 flex-col gap-0.5 rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                // Cheap-fix 3 (round 1 review): focus moves back to this
                // menu's own trigger *before* `onSelect` runs, the same
                // "never leave focus stranded" discipline the `Escape`
                // path above already holds itself to — without this, the
                // just-activated `<button role="menuitem">` (removed from
                // the DOM the instant `setOpen(false)` above unmounts the
                // popup) leaves focus nowhere, and `Modal.tsx`'s own
                // focus-restoration (if `onSelect` opens a prompt, as
                // Rename/Duplicate do) then restores focus to `<body>`
                // once that dialog closes, stranding a keyboard user at
                // the top of the page.
                buttonRef.current?.focus()
                item.onSelect()
              }}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:text-neutral-400 ${
                item.destructive
                  ? 'text-danger-700 hover:bg-danger-50'
                  : 'text-neutral-800 hover:bg-neutral-100'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
