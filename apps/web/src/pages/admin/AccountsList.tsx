/**
 * ADMIN-10 — the console's Users screen: every account on the platform,
 * newest first — name, email, when it joined, whether it is disabled, how
 * many organizations it belongs to, and its total cost. Each row links to
 * that account's own console screen (ADMIN-11). Fetched with
 * `fetchAdminAccounts()`.
 *
 * ADMIN-12 — a search field above the table, matching a name or an email.
 */

import type { AdminAccountSummary } from '../../api/types.js'
import { AppLink } from '../../components/AppLink.js'
import { Button } from '../../components/Button.js'
import { LoadingStatus, SkeletonRow } from '../../components/Skeleton.js'
import type { Route } from '../../routing/route.js'
import { SearchField, useListSearch } from './SearchField.js'
import { formatMicros } from './shared.js'

export function AccountsList({
  accounts,
  failed,
  navigate,
  onBack,
}: {
  accounts: AdminAccountSummary[] | undefined
  /** See `OrganizationsList`'s own `failed` — same reason, same treatment. */
  failed: boolean
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onBack: () => void
}) {
  // ADMIN-12 — name or email, joined into one string.
  const search = useListSearch(
    accounts,
    (account) => `${account.displayName} ${account.email}`
  )

  return (
    <div className="flex flex-col gap-4">
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <h2 className="text-page-title font-semibold text-neutral-900">Users</h2>
      {accounts === undefined ? (
        failed ? null : (
          // WEB-45: shaped like the `<li>` rows below, once the read resolves.
          <div className="flex flex-col gap-3">
            <SkeletonRow />
            <SkeletonRow />
            <LoadingStatus />
          </div>
        )
      ) : accounts.length === 0 ? (
        <p className="text-sm text-neutral-500">No accounts yet.</p>
      ) : (
        <>
          <SearchField
            id="admin-accounts"
            label="Search users"
            placeholder="Search by name or email"
            query={search.query}
            onChange={search.setQuery}
            matchCount={search.matchCount}
            totalCount={search.totalCount}
            itemLabel="accounts"
          />
          {search.filtered && search.filtered.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No accounts match “{search.query}”.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-left text-sm"
                data-testid="admin-accounts"
              >
                <thead>
                  <tr className="text-xs font-medium text-neutral-500">
                    <th className="py-1 pr-4">Name</th>
                    <th className="py-1 pr-4">Email</th>
                    <th className="py-1 pr-4">Joined</th>
                    <th className="py-1 pr-4">Disabled</th>
                    <th className="py-1 pr-4">Organizations</th>
                    <th className="py-1">Total cost</th>
                  </tr>
                </thead>
                <tbody>
                  {search.filtered?.map((account) => (
                    <tr
                      key={account.accountId}
                      data-testid={`admin-account-${account.accountId}`}
                      className="border-t border-neutral-100"
                    >
                      <td className="py-1 pr-4">
                        <AppLink
                          to={{
                            kind: 'admin-account',
                            accountId: account.accountId,
                          }}
                          navigate={navigate}
                          className="font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          {account.displayName}
                        </AppLink>
                      </td>
                      <td className="py-1 pr-4 text-neutral-700">
                        {account.email}
                      </td>
                      <td className="py-1 pr-4 text-neutral-700">
                        {new Date(account.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-1 pr-4 text-neutral-700">
                        {account.disabledAt === null ? 'No' : 'Yes'}
                      </td>
                      <td className="py-1 pr-4 text-neutral-700">
                        {account.organizationCount}
                      </td>
                      <td className="py-1 text-neutral-700">
                        {formatMicros(account.totalCostMicros)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
