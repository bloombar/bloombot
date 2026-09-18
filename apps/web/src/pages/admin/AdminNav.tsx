/**
 * WEB-54 — the console's own secondary navigation, rendered by `Admin`
 * above whichever of its screens is current, so every one of them carries
 * it. Real links (`AppLink`), not buttons — the same "a real `href`, but an
 * ordinary click still does client-side navigation" treatment `AppLink`'s
 * own module comment gives every other in-panel destination, so a
 * middle-click or cmd-click opens a destination in a new tab exactly the
 * way the rest of the panel's own links already do. Navigation pushes
 * (`AppLink` calls `navigate` with no `{ replace: true }`), WEB-34's
 * ordinary rule.
 *
 * ADMIN-10 — adds **Users**, between Courses and Deletion history, the
 * console's own new top-level destination for `fetchAdminAccounts()`'s
 * list.
 */

import { AppLink } from '../../components/AppLink.js'
import type { AdminRoute, Route } from '../../routing/route.js'

export function AdminNav({
  route,
  navigate,
}: {
  route: AdminRoute
  navigate: (route: Route, options?: { replace?: boolean }) => void
}) {
  // The console's own detail screens mark their own parent list current —
  // an operator who has drilled into one organization, project, course or
  // account is still, for the purpose of this nav, on that entity's own
  // list screen.
  const items: {
    key: string
    label: string
    to: AdminRoute
    current: boolean
  }[] = [
    {
      key: 'organizations',
      label: 'Organizations',
      to: { kind: 'admin-organizations' },
      current:
        route.kind === 'admin-organizations' ||
        route.kind === 'admin-organization' ||
        // ADMIN-8 — a project has no top-level list of its own; its own
        // screen is always reached by a link from an organization (or a
        // course), so it marks Organizations current, the same "reached
        // from a link, not a list of its own" treatment `admin-course`
        // already gets from Courses below.
        route.kind === 'admin-project',
    },
    {
      key: 'courses',
      label: 'Courses',
      to: { kind: 'admin-courses' },
      current: route.kind === 'admin-courses' || route.kind === 'admin-course',
    },
    // ADMIN-10 — the Users list, and ADMIN-11's own account screen marking
    // it current, the same "detail marks its parent list current" shape
    // every other pair here already follows.
    {
      key: 'users',
      label: 'Users',
      to: { kind: 'admin-accounts' },
      current:
        route.kind === 'admin-accounts' || route.kind === 'admin-account',
    },
    {
      key: 'deletions',
      label: 'Deletion history',
      to: { kind: 'admin-deletions' },
      current: route.kind === 'admin-deletions',
    },
  ]

  return (
    <nav
      aria-label="Console"
      className="flex flex-wrap gap-4 border-b border-neutral-200 pb-4"
    >
      {items.map((item) => (
        <AppLink
          key={item.key}
          to={item.to}
          navigate={navigate}
          aria-current={item.current ? 'page' : undefined}
          className={
            item.current
              ? 'text-sm font-medium text-brand-700'
              : 'text-sm font-medium text-neutral-600 hover:text-neutral-900'
          }
        >
          {item.label}
        </AppLink>
      ))}
    </nav>
  )
}
