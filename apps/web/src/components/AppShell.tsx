/**
 * WEB-14: the conventional application shell — a fixed header carrying the
 * main navigation (a hamburger menu on narrow screens, a home control
 * beside it), a fixed footer carrying the standard links, and a main
 * content area that scrolls independently between them. `pages/Shell.tsx`
 * renders its own screens as this component's `children`; nothing else in
 * this app repeats this markup — a page never renders its own header or
 * footer.
 *
 * WEB-13: the nav collapses to a hamburger below Tailwind's `md` breakpoint
 * and shows as a plain row of links at `md` and above — the same
 * `navItems` list drives both, so there is no separate "mobile nav" data
 * to keep in sync with the desktop one.
 *
 * WEB-17: the mobile nav is a native `<dialog>` (the same device
 * `ConfirmDialog.tsx` uses, and for the same reason — focus trap, `Escape`
 * to close and focus restoration all come from the browser rather than a
 * hand-rolled implementation of each). Every link and button here is a
 * real `<button>`/`<a>`, reachable and operable by keyboard with no
 * special handling.
 */

import { useRef, type ReactNode } from 'react'

import { CloseIcon, HomeIcon, MenuIcon } from '../icons.js'
import { Button } from './Button.js'

export interface AppShellNavItem {
  key: string
  label: string
  onClick: () => void
  active: boolean
}

export interface AppShellProps {
  /** The primary navigation — rendered as a row at `md` and above, and inside the mobile drawer below it. */
  navItems: AppShellNavItem[]
  /** Called when the home control (next to the hamburger, WEB-14) is activated — the page this app treats as "home" (`pages/Shell.tsx`'s own default tab). */
  onHome: () => void
  /** The organization switcher and sign-out control — placed at the header's trailing edge, the same position every conventional app puts account-level controls. */
  headerEnd: ReactNode
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

export function AppShell({
  navItems,
  onHome,
  headerEnd,
  children,
}: AppShellProps) {
  const drawerRef = useRef<HTMLDialogElement>(null)

  const closeDrawer = () => drawerRef.current?.close()
  const openDrawer = () => drawerRef.current?.showModal()

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="fixed inset-x-0 top-0 z-10 flex h-header items-center justify-between border-b border-neutral-200 bg-white px-4">
        <div className="flex items-center gap-1">
          <div className="md:hidden">
            <Button
              variant="ghost"
              aria-label="Open navigation menu"
              icon={<MenuIcon aria-hidden="true" className="size-5" />}
              onClick={openDrawer}
            />
          </div>
          <Button
            variant="ghost"
            aria-label="Home"
            icon={<HomeIcon aria-hidden="true" className="size-5" />}
            onClick={onHome}
          />
          {/* WEB-13: the same nav items as the mobile drawer, shown as a
              plain row once there is room for one (`md` and above). */}
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={item.onClick}
                aria-current={item.active ? 'page' : undefined}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  item.active
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">{headerEnd}</div>
      </header>

      {/* WEB-17: a native modal dialog — focus trap, `Escape` and focus
          restoration all come from the browser. Styled to sit as a
          left-edge drawer rather than the browser's own centered default. */}
      <dialog
        ref={drawerRef}
        aria-label="Navigation"
        className="m-0 h-full max-h-none w-64 max-w-[80vw] rounded-none border-r border-neutral-200 p-0 backdrop:bg-neutral-900/40 md:hidden"
        style={{ insetInlineStart: 0, insetBlockStart: 0 }}
        onCancel={(event) => {
          event.preventDefault()
          closeDrawer()
        }}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 p-4">
          <span className="text-sm font-semibold text-neutral-900">Menu</span>
          <Button
            variant="ghost"
            aria-label="Close navigation menu"
            icon={<CloseIcon aria-hidden="true" className="size-5" />}
            onClick={closeDrawer}
          />
        </div>
        <nav aria-label="Main" className="flex flex-col p-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                item.onClick()
                closeDrawer()
              }}
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
        </nav>
      </dialog>

      <main className="mx-auto min-h-[calc(100vh-var(--spacing-header)-var(--spacing-footer))] max-w-4xl px-4 pt-[calc(var(--spacing-header)+1.5rem)] pb-[calc(var(--spacing-footer)+1.5rem)]">
        {children}
      </main>

      <Footer />
    </div>
  )
}
