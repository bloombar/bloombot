/**
 * WEB-3: shows which organization the panel is acting in, and lets a
 * signed-in account that belongs to more than one switch between them — so
 * a person who teaches in two places cannot act in one while believing
 * they are in the other.
 *
 * Finding 4 (rework pass): shows `organizationName`, not the raw id —
 * `GET /auth/me` has carried `{ organizationId, organizationName, role }`
 * per membership since TEN-7 closed that gap (`docs/DECISIONS.md` D-23),
 * this component just did not read the name back yet. Before this fix, an
 * account in two organizations picked between two UUIDs — exactly the case
 * TEN-7 exists for.
 *
 * LINK-10: also offers every organization the account has a *connected*
 * person in but no membership — a student reaching the institution running
 * their course, not an administrator. Combined into one list of `Option`s
 * rather than two separate controls, since "which organization is this
 * panel acting in" is one question regardless of which relationship got the
 * account there; a connected-only option carries no `role` (there is none
 * to show — connecting proves an identity, LINK-3, not administrative
 * authority) and reads "(connected)" in its place, so it never claims a
 * role this account does not actually hold.
 *
 * WEB-30: restyled to sit at the header's leading edge, in the space the
 * nav row vacated (`components/AppShell.tsx`'s own `headerStart` slot) —
 * the "Acting in" prose is dropped (there is no longer room to spare for
 * it next to the home control and, now, the organization name), leaving
 * just the name itself: plain text for the single-organization case, or a
 * `<select>` whose own current value already reads as the active
 * organization's name for the multi-organization case. The `role ?? 'connected'`
 * labelling (this file's own module comment, LINK-10) is unchanged either
 * way.
 *
 * WEB-41 — the single-organization case's plain-text name is now also a
 * link, to that organization's main page (`{ kind: 'projects',
 * organizationId }`), via the shared `AppLink`. The multi-organization
 * `<select>` is untouched: it already navigates the moment a different
 * option is chosen (`onChange`), and a link inside an `<option>` is not a
 * thing HTML has. Same classes as before either way (this file's own
 * "no design change" — WEB-41's brief states this explicitly for the
 * header).
 *
 * WEB-56 — the multi-organization case is a real menu now, not a
 * `<select>`: a native select cannot mark which option is "current" beyond
 * its own selected value, and gives this app no room to add a rename or a
 * leave control next to each row (the very next slice on this same list).
 * Built as a hand-rolled popup, the same device — and the same keyboard,
 * focus and dismissal discipline — `components/KebabMenu.tsx` already gets
 * right (that file's own module comment has the full reasoning this one
 * does not repeat): `Escape` closes it and returns focus to the trigger, a
 * click outside closes it too, and only one instance is ever open at once,
 * broadcast through `ORGANIZATION_MENU_OPEN_EVENT` below — a distinct event
 * name from `KebabMenu`'s own, since the two widgets have no reason to
 * close one another. Deliberately not `role="menu"`/`role="menuitem"`, the
 * identical reasoning `KebabMenu.tsx`'s own module comment gives: every
 * item here is an ordinary, independently-focusable `<button>`, reached by
 * `Tab` like any other run of buttons, not a widget promising arrow-key
 * navigation it does not implement. This same control now also renders
 * above the drawer's own links (`components/SignedInChrome.tsx`), with a
 * distinct `data-testid` there so the two copies are never ambiguous to a
 * test or to `getByTestId` — the header's own keeps `organization-switcher`
 * unchanged.
 */

import { useEffect, useId, useRef, useState } from 'react'

import type {
  ConnectedOrganizationSummary,
  MembershipSummary,
} from '../api/types.js'
import { ExpandIcon } from '../icons.js'
import { routeForTab, type Route } from '../routing/route.js'
import { AppLink } from './AppLink.js'
import { Button } from './Button.js'

export interface OrganizationSwitcherProps {
  memberships: MembershipSummary[]
  connectedOrganizations: ConnectedOrganizationSummary[]
  activeOrganizationId: string
  onChange: (organizationId: string) => void
  /** WEB-41 — `routing/useRoute.ts`'s own `navigate`, already wrapped in `pages/Shell.tsx`'s own `guardedNavigate` (WEB-16) before it reaches here — the same guarding `changeActiveOrganization`'s own call to this component's `onChange` already gets, so a dirty form elsewhere in the tree gets the same say before this link is honoured that it gets before every other navigation this shell starts. Only the single-organization plain-text case (below) uses it. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** WEB-56 — `components/SignedInChrome.tsx`'s own drawer copy of this control passes a distinct id, so `data-testid="organization-switcher"` never matches two elements at once. Defaults to the header's own long-standing id, unchanged for every existing caller. */
  testId?: string
}

/** One organization this switcher can offer — a membership's own role, or `undefined` for a connected-only relationship (this file's own module comment). */
interface Option {
  organizationId: string
  organizationName: string
  role?: string
}

/** WEB-56 — broadcast the instant this menu opens, the identical device `KebabMenu.tsx` already uses for the same reason (that file's own module comment) — a distinct event name from `KebabMenu`'s own, since the two widgets have no reason to close one another, but this one still has to close its *own* other copy (the header's and the drawer's both render one). */
const ORGANIZATION_MENU_OPEN_EVENT = 'bloombot:organization-menu-open'

export function OrganizationSwitcher({
  memberships,
  connectedOrganizations,
  activeOrganizationId,
  onChange,
  navigate,
  testId = 'organization-switcher',
}: OrganizationSwitcherProps) {
  const options: Option[] = [
    ...memberships.map((membership) => ({
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      role: membership.role,
    })),
    ...connectedOrganizations.map((connection) => ({
      organizationId: connection.organizationId,
      organizationName: connection.organizationName,
    })),
  ]
  const active = options.find(
    (option) => option.organizationId === activeOrganizationId
  )

  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()

  // WEB-56 — only one copy of this menu open at a time, the same "a second
  // one opening (even by keyboard) closes any other" discipline
  // `KebabMenu.tsx`'s own module comment describes, needed here too since
  // the header and the drawer each render their own instance.
  useEffect(() => {
    function handleOtherMenuOpened(event: Event) {
      const openedId = (event as CustomEvent<string>).detail
      if (openedId !== id) setOpen(false)
    }
    window.addEventListener(ORGANIZATION_MENU_OPEN_EVENT, handleOtherMenuOpened)
    return () =>
      window.removeEventListener(
        ORGANIZATION_MENU_OPEN_EVENT,
        handleOtherMenuOpened
      )
  }, [id])

  // WEB-56 — `Escape` and "click away" both close the menu, the identical
  // pair `KebabMenu.tsx` already wires for the identical reason (neither is
  // a browser default for a hand-built popup).
  useEffect(() => {
    if (!open) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
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

  // A single option is the common case (TEN-1's personal organization,
  // created on first sign-in) — shown plainly rather than as a one-item
  // menu nobody needs to operate. WEB-30: no "Acting in" prose anymore
  // (this file's own module comment) — just the name, and the role/
  // "connected" label LINK-10 already required.
  if (options.length <= 1) {
    // WEB-41 — a member reaches this organization's Projects tab; a
    // connected-only person (this option's own `role === undefined`,
    // exactly how "connected" above is already decided) is forced to Chat
    // by `Shell.tsx`'s own `effectiveTab` the moment they land anywhere
    // else in that organization, and it replaces the address to match
    // (`Shell.tsx`'s own module comment on that rule) — a link to Projects
    // would hover- and cmd-click-advertise a screen this account never
    // actually reaches, and a plain click would flash it before the
    // replace corrected it. `routeForTab` is the same mapping
    // `Shell.tsx#onHome` already uses one line above `isMember`'s own
    // definition there.
    const activeRoute = active
      ? routeForTab(
          active.role !== undefined ? 'projects' : 'chat',
          active.organizationId
        )
      : undefined
    return (
      <p className="text-sm font-medium text-neutral-900" data-testid={testId}>
        {/* WEB-41 — a link to this organization's main page. No classes of
            its own: Tailwind's Preflight already resets an anchor's color
            and text-decoration to `inherit`, and font-size/weight are
            inherited by any element regardless, so this reads exactly as
            the plain text it replaces (the brief's own "same font, size,
            weight, color, spacing" — no underline, no brand color to
            resist adding here). The role label stays outside the link
            (`Account.tsx`'s rows now match this too), so the accessible
            name is the organization's name alone, not "Acme U (owner)". */}
        {active && activeRoute ? (
          <AppLink to={activeRoute} navigate={navigate}>
            {active.organizationName}
          </AppLink>
        ) : (
          activeOrganizationId
        )}
        {active ? (
          <span className="font-normal text-neutral-500">
            {' '}
            ({active.role ?? 'connected'})
          </span>
        ) : (
          ''
        )}
      </p>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative inline-block text-left"
      data-testid={testId}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        aria-haspopup="true"
        aria-expanded={open}
        icon={<ExpandIcon aria-hidden="true" className="size-4" />}
        onClick={() => {
          setOpen((current) => {
            const next = !current
            // Only announced on the way *open* — the identical
            // "no sibling to tell anything to on the way closed"
            // reasoning `KebabMenu.tsx`'s own trigger already follows.
            if (next) {
              window.dispatchEvent(
                new CustomEvent(ORGANIZATION_MENU_OPEN_EVENT, { detail: id })
              )
            }
            return next
          })
        }}
      >
        {active ? active.organizationName : activeOrganizationId}
        {active ? (
          <span className="font-normal text-neutral-500">
            {' '}
            ({active.role ?? 'connected'})
          </span>
        ) : (
          ''
        )}
      </Button>
      {open && (
        <div
          role="group"
          aria-label="Organizations"
          className="absolute left-0 z-10 mt-1 flex min-w-48 flex-col gap-0.5 rounded-md border border-neutral-200 bg-white p-1 shadow-lg"
        >
          {options.map((option) => {
            const isActive = option.organizationId === activeOrganizationId
            return (
              <button
                key={option.organizationId}
                type="button"
                aria-current={isActive ? 'true' : undefined}
                onClick={() => {
                  setOpen(false)
                  // WEB-56 — focus returns to this menu's own trigger
                  // before the switch itself runs, the same "never leave
                  // focus stranded" discipline `KebabMenu.tsx`'s own item
                  // click already holds itself to.
                  triggerRef.current?.focus()
                  if (!isActive) onChange(option.organizationId)
                }}
                className={`rounded px-2 py-1.5 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-neutral-800 hover:bg-neutral-100'
                }`}
              >
                {option.organizationName}{' '}
                <span className="font-normal text-neutral-500">
                  ({option.role ?? 'connected'})
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
