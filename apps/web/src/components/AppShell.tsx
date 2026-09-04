/**
 * WEB-14: the conventional application shell — a fixed header carrying the
 * primary navigation (a hamburger control beside the home control), a fixed
 * footer carrying the standard links, and a main content area that scrolls
 * independently between them. `pages/Shell.tsx` renders its own screens as
 * this component's `children`; nothing else in this app repeats this
 * markup — a page never renders its own header or footer.
 *
 * WEB-29: the primary navigation lives in exactly one place — a full-height
 * drawer, at every screen width, opened by the hamburger control. There is
 * no second, wider-screen copy of the same links; before this slice
 * (WEB-13's own original text), the same `navItems` list drove both a
 * `md:hidden` drawer and a `hidden md:flex` header row, which is what made
 * WEB-29's rework necessary in the first place — "works on the screen a
 * person actually has" is still the goal, but a plain row at `md` and above
 * was never a requirement in its own right, and keeping it left the header
 * with no room for WEB-30's own organization name. `navGroups` (rather than
 * a single flat `navItems` list) is what lets the drawer draw a divider
 * between the links every signed-in account gets and the ones only an
 * organization's own members get (`pages/Shell.tsx`'s own module comment on
 * `isMember`) — the divider is data this component renders, not an index
 * `pages/Shell.tsx` would otherwise have to hardcode here.
 *
 * WEB-17: the drawer is a native `<dialog>` (the same device
 * `components/modal/Modal.tsx` uses, and for the same reason — focus trap,
 * `Escape` to close and focus restoration all come from the browser rather
 * than a hand-rolled implementation of each; `e2e/keyboard.spec.ts` depends
 * on exactly this). Every link and button here is a real `<button>`/`<a>`,
 * reachable and operable by keyboard with no special handling.
 *
 * WEB-29's own animation: the drawer slides in from the leading edge rather
 * than simply appearing, and the backdrop fades with it. `dialog.close()`
 * removes the element from the top layer on the same tick it is called, so
 * calling it immediately on a closing click would cut the slide-out short
 * before a person ever sees it — `phase` below is what defers that call
 * until the transition has actually finished (`transitionend`, below), with
 * a timeout of the same duration as a fallback: jsdom (`apps/web/tests`'s
 * own environment) fires no transition events at all, and this app's own
 * tests must see the drawer close without resorting to fake timers.
 * `prefers-reduced-motion: reduce` collapses the same transition to `0ms`
 * (the `motion-reduce:` variant, below) — a `0ms` CSS transition fires no
 * `transitionend` at all, so the closing effect reads the identical media
 * query directly and closes immediately rather than waiting on an event
 * that will never come (coordinator review finding, below). The
 * `transitionend` listener is also filtered to the dialog's own transition
 * (`event.target !== dialog`) — every `Button` inside the drawer carries
 * its own `transition-colors` (`Button.tsx`), and that bubbling event was
 * closing the drawer early, mid-slide, on an unrelated hover-color
 * transition finishing first (coordinator review finding, below).
 */

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'

import { CloseIcon, HomeIcon, MenuIcon } from '../icons.js'
import { Button } from './Button.js'

export interface AppShellNavItem {
  key: string
  label: string
  onClick: () => void
  active: boolean
}

/**
 * WEB-16/WEB-29: the drawer's own imperative handle — `pages/Shell.tsx`
 * reads a `ref` of this shape so it can close the drawer itself, from
 * *inside* the `guardedNavigate` callback each nav item's `onClick` already
 * runs through, rather than this component closing it unconditionally the
 * instant an item is clicked. The distinction matters: a click on an item
 * that turns out to be guarded (a dirty form elsewhere in the tree) opens a
 * confirm dialog *on top of* the still-open drawer — the drawer only
 * actually closes once that confirmation resolves (or never, if it is
 * cancelled) — so `e2e/keyboard.spec.ts`'s own focus-restoration assertion
 * has a stable, still-attached element to restore focus to; had this
 * component closed the drawer eagerly instead, the clicked item would be
 * mid-close (or already gone from the top layer) by the time the confirm
 * dialog's own `Escape` handling tried to restore focus to it.
 */
export interface AppShellHandle {
  closeDrawer: () => void
}

/**
 * WEB-29: one group of nav items in the drawer — `label` is optional
 * because the first group (the links every signed-in account gets) needs
 * none, only the second (organization-scoped) group does, and only to
 * introduce the divider above it. A group with no items renders nothing
 * (`pages/Shell.tsx`'s connected-but-not-a-member account passes a single
 * group and no second one at all, rather than an empty organization group).
 */
export interface AppShellNavGroup {
  key: string
  label?: string
  items: AppShellNavItem[]
}

export interface AppShellProps {
  /** WEB-29: the drawer's own navigation, grouped so the divider between "every account" and "organization members only" is data, not a hardcoded index. */
  navGroups: AppShellNavGroup[]
  /** Called when the home control (next to the hamburger, WEB-14) is activated — the page this app treats as "home" (`pages/Shell.tsx`'s own default tab). */
  onHome: () => void
  /** WEB-30: rendered at the header's leading edge, right of the home control, in the space the nav row vacated — the acting organization's name (`components/OrganizationSwitcher.tsx`, restyled for exactly this slot). */
  headerStart: ReactNode
  /** WEB-30: rendered at the header's trailing edge — the profile control that opens account settings. The organization switcher and sign-out, which both lived here before this slice, have moved (to `headerStart` and the drawer's foot, respectively) — this slot now carries the profile control alone. */
  headerEnd: ReactNode
  /** WEB-29: the drawer's own foot — sign-out. A slot, not a bespoke `onSignOut`/`signOutLabel` pair: `pages/Shell.tsx`'s sign-out button already carries its own pending-state label ("Signing out…") and `guardedNavigate` wiring, and passing the whole rendered control through is less for this component to know about than reconstructing an equivalent set of props for one button. */
  drawerFooter: ReactNode
  children: ReactNode
}

/** WEB-14's footer content — the conventional links and information a person expects there: what this is, how to reach support, and the year. Not a page of its own (this slice does not add a privacy/terms page to link to) — a support address is the one link this panel can honestly offer today. */
function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="fixed inset-x-0 bottom-0 z-10 flex h-footer items-center justify-between border-t border-neutral-200 bg-white px-4 text-sm text-neutral-500">
      <p>© {year} Bloombot</p>
      <a
        href="mailto:support@bloombot.example"
        className="hover:text-neutral-700 hover:underline"
      >
        Support
      </a>
    </footer>
  )
}

/** WEB-29's own module comment: how long the drawer's slide/fade transition runs — the CSS classes below (`duration-200`) and the JS fallback timer (this constant) have to agree, or the timeout would fire before (leaving a visible jump) or long after (a needless delay before `dialog.close()`) the CSS transition it stands in for. */
const DRAWER_TRANSITION_MS = 200

/**
 * WEB-29: the drawer's own lifecycle, driving both its transform (open vs.
 * closed position) and when the underlying `<dialog>` actually opens/closes
 * — see this file's own module comment for why closing is not immediate.
 *
 *  - `closed` — not in the top layer at all; the common resting state.
 *  - `entering` — `showModal()` has just run, but this render still paints
 *    the closed position; the effect below flips to `open` on the very next
 *    frame, so the browser has a "before" position to transition from
 *    rather than starting already at "after."
 *  - `open` — showing, translated into view.
 *  - `closing` — sliding back to the closed position; `dialog.close()` has
 *    not run yet, so the dialog is still technically open (and still
 *    trapping focus) for the duration of the transition.
 */
type DrawerPhase = 'closed' | 'entering' | 'open' | 'closing'

export function AppShell({
  navGroups,
  onHome,
  headerStart,
  headerEnd,
  drawerFooter,
  children,
  ref,
}: AppShellProps & { ref?: Ref<AppShellHandle> }) {
  const drawerRef = useRef<HTMLDialogElement>(null)
  const [phase, setPhase] = useState<DrawerPhase>('closed')

  const openDrawer = () => {
    drawerRef.current?.showModal()
    setPhase('entering')
  }
  const closeDrawer = () => {
    if (phase === 'closed' || phase === 'closing') return
    setPhase('closing')
  }

  // `entering` -> `open`, one frame later, so the transform actually has a
  // "before" value to animate away from (this file's own module comment).
  useEffect(() => {
    if (phase !== 'entering') return
    const frame = requestAnimationFrame(() => setPhase('open'))
    return () => cancelAnimationFrame(frame)
  }, [phase])

  // `closing` -> `dialog.close()`, deferred until the transition finishes —
  // whichever fires first, a real `transitionend` or the timeout fallback
  // jsdom needs (this file's own module comment). Coordinator review
  // finding 1: `transitionend` bubbles, and every `Button` in the drawer
  // (the close control, sign-out) carries its own `transition-colors`
  // (`Button.tsx`) — a hover-state color transition on one of *those*,
  // finishing before the drawer's own translate does, would bubble up and
  // fire `finish()` early, cutting the slide short (precisely the
  // "disappearing before it visibly finishes" behaviour WEB-29 exists to
  // rule out). `event.target !== dialog` filters to the dialog's own
  // transition only.
  //
  // Coordinator review finding 2: `prefers-reduced-motion: reduce`
  // (`motion-reduce:duration-0`, below) makes the transform transition
  // instant — and a `0ms` CSS transition fires no `transitionend` at all
  // (nothing to transition from/to), so a reduced-motion caller would
  // always fall through to the `DRAWER_TRANSITION_MS` timeout, holding the
  // native `<dialog>` open — and the rest of the document inert — for
  // 200ms after the drawer is already visually gone. Read directly off the
  // same `prefers-reduced-motion` media query the CSS itself keys off, so
  // JS and CSS can never disagree about whether *this* close will actually
  // transition: when it matches, `finish()` runs immediately rather than
  // waiting on a `transitionend` that will never come.
  useEffect(() => {
    if (phase !== 'closing') return
    const dialog = drawerRef.current
    if (!dialog) return
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      dialog.close()
      setPhase('closed')
    }
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      finish()
      return
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== dialog) return
      finish()
    }
    dialog.addEventListener('transitionend', onTransitionEnd)
    const timeoutId = setTimeout(finish, DRAWER_TRANSITION_MS)
    return () => {
      dialog.removeEventListener('transitionend', onTransitionEnd)
      clearTimeout(timeoutId)
    }
  }, [phase])

  const isOpen = phase === 'open'

  // WEB-16/WEB-29: exposed so `pages/Shell.tsx` can close the drawer itself
  // once a guarded navigation actually proceeds — this file's own
  // `AppShellHandle` doc comment has the full reasoning.
  useImperativeHandle(ref, () => ({ closeDrawer }), [closeDrawer])

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="fixed inset-x-0 top-0 z-10 flex h-header items-center justify-between border-b border-neutral-200 bg-white px-4">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            aria-label="Open navigation menu"
            icon={<MenuIcon aria-hidden="true" className="size-5" />}
            onClick={openDrawer}
          />
          <Button
            variant="ghost"
            aria-label="Home"
            icon={<HomeIcon aria-hidden="true" className="size-5" />}
            onClick={onHome}
          />
          {/* WEB-30: the acting organization's name, in the space the nav
              row vacated. */}
          {headerStart}
        </div>
        <div className="flex items-center gap-3">{headerEnd}</div>
      </header>

      {/* WEB-17: a native modal dialog — focus trap, `Escape` and focus
          restoration all come from the browser. Styled to sit as a
          left-edge drawer rather than the browser's own centered default.
          WEB-29: the only nav, at every width — no `md:hidden` here
          anymore. The transform/backdrop classes below switch on `phase`
          (this file's own module comment); `motion-reduce:duration-0`
          collapses the same transition to instant for
          `prefers-reduced-motion: reduce`, rather than a separate code
          path. */}
      <dialog
        ref={drawerRef}
        aria-label="Navigation"
        className={`m-0 h-full max-h-none w-64 max-w-[80vw] rounded-none border-r border-neutral-200 p-0 backdrop:transition-colors backdrop:duration-200 backdrop:motion-reduce:duration-0 transition-transform duration-200 ease-in-out motion-reduce:duration-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        } ${isOpen ? 'backdrop:bg-neutral-900/40' : 'backdrop:bg-neutral-900/0'}`}
        style={{ insetInlineStart: 0, insetBlockStart: 0 }}
        onCancel={(event) => {
          // Escape's default is an immediate close — prevented so the same
          // sliding-closed transition every other close path takes runs
          // here too, rather than the drawer vanishing outright.
          event.preventDefault()
          closeDrawer()
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-neutral-200 p-4">
            <span className="text-sm font-semibold text-neutral-900">Menu</span>
            <Button
              variant="ghost"
              aria-label="Close navigation menu"
              icon={<CloseIcon aria-hidden="true" className="size-5" />}
              onClick={closeDrawer}
            />
          </div>
          <nav aria-label="Main" className="flex flex-1 flex-col gap-1 p-2">
            {navGroups.map((group, index) => (
              <div key={group.key} className="flex flex-col gap-1">
                {/* WEB-29: a visible divider above every group but the
                    first — data-driven (`navGroups`), not a hardcoded
                    index into one flat list. */}
                {index > 0 && (
                  <hr
                    role="separator"
                    aria-label={group.label}
                    className="my-2 border-t border-neutral-200"
                  />
                )}
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    // WEB-16/WEB-29: this does *not* also call `closeDrawer()`
                    // — `item.onClick` is `pages/Shell.tsx`'s own
                    // `guardedNavigate`-wrapped callback, and it is that
                    // callback's job to close the drawer (via the
                    // `AppShellHandle` ref) once the navigation it guards
                    // actually happens, not merely once it is clicked. See
                    // `AppShellHandle`'s own doc comment above for why the
                    // difference is load-bearing.
                    onClick={item.onClick}
                    aria-current={item.active ? 'page' : undefined}
                    className={`rounded-md px-3 py-2 text-left text-sm font-medium ${
                      item.active
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-neutral-600 hover:bg-neutral-100'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          {/* WEB-29: sign-out sits at the drawer's foot, not the header —
              this file's own module comment on why `drawerFooter` is a
              slot rather than a bespoke prop pair. */}
          <div className="border-t border-neutral-200 p-2">{drawerFooter}</div>
        </div>
      </dialog>

      <main className="mx-auto min-h-[calc(100vh-var(--spacing-header)-var(--spacing-footer))] max-w-4xl px-4 pt-[calc(var(--spacing-header)+1.5rem)] pb-[calc(var(--spacing-footer)+1.5rem)]">
        {children}
      </main>

      <Footer />
    </div>
  )
}
