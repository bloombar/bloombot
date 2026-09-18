/**
 * WEB-33's `'admin-deletions'` screen — ADMIN-5's own audit trail,
 * unchanged in content from what `Admin` used to render inline, at its
 * own address.
 *
 * ADMIN-12 — a search field above the list, matching the deleted
 * organization's own name.
 */

import { Button } from '../../components/Button.js'
import { LoadingStatus, SkeletonRow } from '../../components/Skeleton.js'
import type { TenantDeletion } from '../../api/types.js'
import { SearchField, useListSearch } from './SearchField.js'

export function DeletionsView({
  deletions,
  failed,
  onBack,
}: {
  deletions: TenantDeletion[] | undefined
  /** True once the read this screen renders from has failed — the refusal itself is already on screen above (`Admin`'s own `ErrorMessage`), so this screen must not also claim to still be loading. */
  failed: boolean
  onBack: () => void
}) {
  // ADMIN-12 — by the deleted organization's own name.
  const search = useListSearch(
    deletions,
    (deletion) => deletion.organizationName
  )

  return (
    <div className="flex flex-col gap-4">
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <h2 className="text-sm font-semibold text-neutral-900">
        Deletion history
      </h2>
      {deletions === undefined ? (
        failed ? null : (
          // WEB-45: shaped like the `<li>` deletions just below.
          <div className="flex flex-col gap-2">
            <SkeletonRow />
            <SkeletonRow />
            <LoadingStatus />
          </div>
        )
      ) : deletions.length === 0 ? (
        <p className="text-sm text-neutral-500">No deletions yet.</p>
      ) : (
        <>
          <SearchField
            id="admin-deletions"
            label="Search deletion history"
            placeholder="Search by organization name"
            query={search.query}
            onChange={search.setQuery}
            matchCount={search.matchCount}
            totalCount={search.totalCount}
            itemLabel="deletions"
          />
          {search.filtered && search.filtered.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No deletions match “{search.query}”.
            </p>
          ) : (
            <ul
              className="flex flex-col gap-2"
              data-testid="admin-tenant-deletions"
            >
              {search.filtered?.map((deletion) => (
                <li
                  key={deletion.id}
                  className="rounded-md border border-neutral-200 p-3 text-xs text-neutral-600"
                >
                  <span className="font-medium text-neutral-900">
                    {deletion.organizationName}
                  </span>{' '}
                  — deleted {new Date(deletion.deletedAt).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
