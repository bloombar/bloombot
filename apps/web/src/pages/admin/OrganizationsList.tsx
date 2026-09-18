/** WEB-33's `'admin-organizations'` screen — every organization, its usage, and its inline Delete action, unchanged in content from before this slice's split of `pages/Admin.tsx` into this directory. */

import type { AdminOrganizationsResponse } from '../../api/types.js'
import { Button } from '../../components/Button.js'
import { LoadingStatus, SkeletonRow } from '../../components/Skeleton.js'
import { DeleteIcon } from '../../icons.js'
import { formatBySurface, formatMicros } from './shared.js'

export function OrganizationsList({
  data,
  failed,
  deletingId,
  onOpen,
  onDelete,
  onViewDeletions,
  onViewCourses,
  onViewUsers,
}: {
  data: AdminOrganizationsResponse | undefined
  /** True once the read this screen renders from has failed — the refusal itself is already on screen above (`Admin`'s own `ErrorMessage`), so this screen must not also claim to still be loading. Guards against a non-administrator seeing the 403 *and* a permanent "Loading…" underneath it. */
  failed: boolean
  deletingId: string | undefined
  onOpen: (organizationId: string) => void
  onDelete: (organizationId: string, name: string) => void
  onViewDeletions: () => void
  /** WEB-53 — the console's own entry point into the Courses screen. */
  onViewCourses: () => void
  /** ADMIN-10 — the console's own entry point into the Users screen. */
  onViewUsers: () => void
}) {
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
        <ul className="flex flex-col gap-3" data-testid="admin-organizations">
          {data.organizations.map((organization) => (
            <li
              key={organization.organizationId}
              data-testid={`admin-org-${organization.organizationId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <button
                  type="button"
                  onClick={() => onOpen(organization.organizationId)}
                  className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {organization.organizationName}
                </button>
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
