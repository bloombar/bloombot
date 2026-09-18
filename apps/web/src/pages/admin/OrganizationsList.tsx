/**
 * WEB-33's `'admin-organizations'` screen — every organization, its usage,
 * and its inline Delete action, unchanged in content from before this
 * slice's split of `pages/Admin.tsx` into this directory.
 *
 * ADMIN-12 — a search field above the list, filtering by name over the
 * rows this screen already fetched (`shared.js`'s own sibling,
 * `SearchField.js`, has the shared "how" — this file only supplies which
 * field a row is matched against).
 *
 * Entity link, not button: an organization's own name is an `AppLink`
 * into `'admin-organization'`, matching every one of the console's own
 * detail screens — a `<button onClick={() => navigate(...)}>` here (this
 * screen's own pre-ADMIN-12 shape) could not be middle-clicked, copied, or
 * opened in a new tab the way every other entity link in this console
 * already can (`AppLink.js`'s own module comment).
 */

import type { AdminOrganizationsResponse } from '../../api/types.js'
import { AppLink } from '../../components/AppLink.js'
import { Button } from '../../components/Button.js'
import { LoadingStatus, SkeletonRow } from '../../components/Skeleton.js'
import { DeleteIcon } from '../../icons.js'
import type { Route } from '../../routing/route.js'
import { SearchField, useListSearch } from './SearchField.js'
import { formatBySurface, formatMicros } from './shared.js'

export function OrganizationsList({
  data,
  failed,
  deletingId,
  navigate,
  onDelete,
  onViewDeletions,
  onViewCourses,
  onViewUsers,
}: {
  data: AdminOrganizationsResponse | undefined
  /** True once the read this screen renders from has failed — the refusal itself is already on screen above (`Admin`'s own `ErrorMessage`), so this screen must not also claim to still be loading. Guards against a non-administrator seeing the 403 *and* a permanent "Loading…" underneath it. */
  failed: boolean
  deletingId: string | undefined
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onDelete: (organizationId: string, name: string) => void
  onViewDeletions: () => void
  /** WEB-53 — the console's own entry point into the Courses screen. */
  onViewCourses: () => void
  /** ADMIN-10 — the console's own entry point into the Users screen. */
  onViewUsers: () => void
}) {
  // ADMIN-12 — by organization name, over whatever `data.organizations`
  // has already fetched.
  const search = useListSearch(
    data?.organizations,
    (organization) => organization.organizationName
  )

  return (
    <>
      {data === undefined ? (
        failed ? null : (
          // WEB-45: shaped like the `<li>` organizations just below.
          <div className="flex flex-col gap-3">
            <SkeletonRow />
            <SkeletonRow />
            <LoadingStatus />
          </div>
        )
      ) : data.organizations.length === 0 ? (
        <p className="text-sm text-neutral-500">No organizations yet.</p>
      ) : (
        <>
          <SearchField
            id="admin-organizations"
            label="Search organizations"
            placeholder="Search by name"
            query={search.query}
            onChange={search.setQuery}
            matchCount={search.matchCount}
            totalCount={search.totalCount}
            itemLabel="organizations"
          />
          {search.filtered && search.filtered.length === 0 ? (
            // ADMIN-12: a search matching nothing says so, rather than
            // rendering an empty `<ul>` — `SearchField`'s own "Showing 0
            // of N" already says as much, but this is the list area's own
            // equivalent of "No organizations yet." above.
            <p className="text-sm text-neutral-500">
              No organizations match “{search.query}”.
            </p>
          ) : (
            <ul
              className="flex flex-col gap-3"
              data-testid="admin-organizations"
            >
              {search.filtered?.map((organization) => (
                <li
                  key={organization.organizationId}
                  data-testid={`admin-org-${organization.organizationId}`}
                  className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <AppLink
                      to={{
                        kind: 'admin-organization',
                        organizationId: organization.organizationId,
                      }}
                      navigate={navigate}
                      className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                    >
                      {organization.organizationName}
                    </AppLink>
                    <p className="text-xs text-neutral-500">
                      {formatMicros(organization.totalCostMicros)} spent ·{' '}
                      {organization.callCount} call(s)
                      {organization.estimatedCostMicros > 0 &&
                        ' · partly estimated'}
                    </p>
                    {organization.bySurface.length > 0 && (
                      // COST-7 — the total above, broken down by surface.
                      <p className="text-xs text-neutral-400">
                        By surface: {formatBySurface(organization.bySurface)}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="destructive"
                    icon={<DeleteIcon aria-hidden="true" className="size-4" />}
                    onClick={() =>
                      onDelete(
                        organization.organizationId,
                        organization.organizationName
                      )
                    }
                    disabled={deletingId === organization.organizationId}
                  >
                    {deletingId === organization.organizationId
                      ? 'Deleting…'
                      : 'Delete'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" onClick={onViewCourses}>
          Courses
        </Button>
        <Button variant="secondary" onClick={onViewUsers}>
          Users
        </Button>
        <Button variant="secondary" onClick={onViewDeletions}>
          Deletion history
        </Button>
      </div>
    </>
  )
}
