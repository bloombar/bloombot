/**
 * ADMIN-11 — one account's own console screen: identity fields, when it
 * joined, whether and when it was disabled, whether it is a platform
 * administrator; the organizations it belongs to with its role in each, and
 * the organizations it is merely connected to; the courses it is enrolled
 * in, with when it enrolled; the people records (PPL-1) associated with it,
 * each with the organization it belongs to, the identities it has been
 * proven on (PPL-2), and when it was connected; and its usage — total cost
 * and call count, broken down by surface and by course, and when it was
 * last active. Every organization, project and course named here links to
 * that entity's own screen. As ADMIN-4 requires, none of this reaches a
 * transcript — `AdminAccountDetail`'s own shape has nothing in it that
 * would even let this screen try.
 *
 * Fetched with `fetchAdminAccount(id)`; `NotFound` renders for
 * `account_not_found` (404), the same treatment every other detail screen
 * in this console already gives an unknown id.
 *
 * WEB-72/DATA-7 — a Danger zone, last on the screen: a platform
 * administrator's own soft-delete, reversible for the deployment's
 * retention window, then permanent. `Admin.tsx#handleSoftDelete` gates it
 * on typing the account's own `displayName` — never `null`
 * (`components/Team.tsx`'s own module comment on why an account's
 * `displayName` always exists, unlike a student person's) — the same
 * typed-name discipline `Admin.tsx#handleDelete` (ADMIN-5) already applies
 * to an organization.
 */

import type { AdminAccountDetail } from '../../api/types.js'
import { AppLink } from '../../components/AppLink.js'
import { Button } from '../../components/Button.js'
import {
  LoadingStatus,
  Skeleton,
  SkeletonLine,
  SkeletonRow,
} from '../../components/Skeleton.js'
import { DeleteIcon } from '../../icons.js'
import type { Route } from '../../routing/route.js'
import { NotFound } from '../NotFound.js'
import { formatBySurface, formatMicros, ReadOnlyField } from './shared.js'

export function AccountDetail({
  accountId,
  account,
  notFound,
  failed,
  deletingId,
  navigate,
  onDelete,
  onBack,
}: {
  accountId: string
  account: AdminAccountDetail | undefined
  /** ADMIN-11 — this account id 404'd, distinct from `failed`. */
  notFound: boolean
  failed: boolean
  /** WEB-72/DATA-7 — the account id currently mid-delete, the same `deletingId` shape `admin/OrganizationDetail.tsx` already uses for ADMIN-5. */
  deletingId: string | undefined
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onDelete: (accountId: string, displayName: string) => void
  onBack: () => void
}) {
  if (notFound) {
    return <NotFound onHome={onBack} />
  }

  if (account === undefined || account.accountId !== accountId) {
    if (failed) {
      return (
        <Button variant="secondary" onClick={onBack}>
          ← Users
        </Button>
      )
    }
    return (
      <div className="flex flex-col gap-3">
        <SkeletonLine className="h-4 w-24" />
        <Skeleton className="h-8 w-64" />
        <SkeletonRow />
        <SkeletonRow />
        <LoadingStatus />
      </div>
    )
  }

  return (
    <div
      className="flex flex-col gap-6"
      data-testid={`admin-account-detail-${account.accountId}`}
    >
      <Button variant="secondary" onClick={onBack}>
        ← Users
      </Button>

      <div>
        <p className="text-xs font-medium text-neutral-500">Account</p>
        <h2 className="text-page-title font-semibold text-neutral-900">
          {account.displayName}
        </h2>
      </div>

      <dl className="flex flex-col gap-2">
        <ReadOnlyField label="Email" value={account.email} />
        <ReadOnlyField label="First name" value={account.firstName ?? '—'} />
        <ReadOnlyField label="Last name" value={account.lastName ?? '—'} />
        <ReadOnlyField
          label="Joined"
          value={new Date(account.createdAt).toLocaleString()}
        />
        <ReadOnlyField
          label="Disabled"
          value={
            account.disabledAt === null
              ? 'No'
              : `Yes, ${new Date(account.disabledAt).toLocaleString()}`
          }
        />
        <ReadOnlyField
          label="Platform administrator"
          value={account.isPlatformAdministrator ? 'Yes' : 'No'}
        />
      </dl>

      <section
        aria-label="Organizations"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Organizations
        </h3>
        {account.memberships.length === 0 ? (
          <p className="text-sm text-neutral-500">No memberships.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {account.memberships.map((membership) => (
              <li key={membership.organizationId} className="text-sm">
                <AppLink
                  to={{
                    kind: 'admin-organization',
                    organizationId: membership.organizationId,
                  }}
                  navigate={navigate}
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {membership.organizationName}
                </AppLink>{' '}
                <span className="text-neutral-500">· {membership.role}</span>
              </li>
            ))}
          </ul>
        )}
        {account.connectedOrganizations.length > 0 && (
          <>
            <h4 className="text-xs font-medium text-neutral-500">
              Connected (no membership)
            </h4>
            <ul className="flex flex-col gap-1">
              {account.connectedOrganizations.map((connection) => (
                <li key={connection.organizationId} className="text-sm">
                  <AppLink
                    to={{
                      kind: 'admin-organization',
                      organizationId: connection.organizationId,
                    }}
                    navigate={navigate}
                    className="font-medium text-brand-700 underline-offset-2 hover:underline"
                  >
                    {connection.organizationName}
                  </AppLink>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section
        aria-label="Enrolments"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Enrolled courses
        </h3>
        {account.enrolments.length === 0 ? (
          <p className="text-sm text-neutral-500">Not enrolled anywhere.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {account.enrolments.map((enrolment) => (
              <li key={enrolment.courseId} className="text-sm">
                <AppLink
                  to={{ kind: 'admin-course', courseId: enrolment.courseId }}
                  navigate={navigate}
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {enrolment.courseTitle}
                </AppLink>{' '}
                <span className="text-neutral-500">
                  ·{' '}
                  <AppLink
                    to={{
                      kind: 'admin-project',
                      projectId: enrolment.projectId,
                    }}
                    navigate={navigate}
                    className="text-brand-700 underline-offset-2 hover:underline"
                  >
                    {enrolment.projectName}
                  </AppLink>{' '}
                  ·{' '}
                  <AppLink
                    to={{
                      kind: 'admin-organization',
                      organizationId: enrolment.organizationId,
                    }}
                    navigate={navigate}
                    className="text-brand-700 underline-offset-2 hover:underline"
                  >
                    {enrolment.organizationName}
                  </AppLink>{' '}
                  · enrolled{' '}
                  {new Date(enrolment.enroledAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="People"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          People records
        </h3>
        {account.people.length === 0 ? (
          <p className="text-sm text-neutral-500">No person records.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {account.people.map((person) => (
              <li
                key={person.personId}
                className="rounded-md border border-neutral-100 p-2 text-sm"
              >
                <p className="font-medium text-neutral-900">
                  {person.displayName ?? person.email ?? person.personId} ·{' '}
                  <AppLink
                    to={{
                      kind: 'admin-organization',
                      organizationId: person.organizationId,
                    }}
                    navigate={navigate}
                    className="font-normal text-brand-700 underline-offset-2 hover:underline"
                  >
                    {person.organizationName}
                  </AppLink>
                </p>
                <p className="text-xs text-neutral-500">
                  Connected{' '}
                  {person.connectedAt === null
                    ? '—'
                    : new Date(person.connectedAt).toLocaleString()}
                </p>
                {person.identities.length > 0 && (
                  <p className="text-xs text-neutral-400">
                    Identities:{' '}
                    {person.identities
                      .map((identity) => identity.surface)
                      .join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ROST-20 — every roster import this account has ever acknowledged, across every course and organization, each course linking to its own console screen. */}
      <section
        aria-label="Roster acknowledgements"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Roster acknowledgements
        </h3>
        {account.rosterAcknowledgements.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No roster import acknowledged.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {account.rosterAcknowledgements.map((entry) => (
              <li key={entry.id} className="text-sm">
                <AppLink
                  to={{ kind: 'admin-course', courseId: entry.courseId }}
                  navigate={navigate}
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {entry.courseTitle}
                </AppLink>{' '}
                <span className="text-neutral-500">
                  ·{' '}
                  <AppLink
                    to={{
                      kind: 'admin-organization',
                      organizationId: entry.organizationId,
                    }}
                    navigate={navigate}
                    className="text-brand-700 underline-offset-2 hover:underline"
                  >
                    {entry.organizationName}
                  </AppLink>{' '}
                  · {entry.filename} ·{' '}
                  {new Date(entry.acknowledgedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="Usage"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Usage
        </h3>
        <p className="text-sm text-neutral-900">
          {formatMicros(account.usage.totalCostMicros)} spent ·{' '}
          {account.usage.callCount} call(s)
          {account.usage.hasEstimated && ' · partly estimated'}
        </p>
        <p className="text-xs text-neutral-500">
          Last active{' '}
          {account.usage.lastActiveAt === null
            ? 'never'
            : new Date(account.usage.lastActiveAt).toLocaleString()}
        </p>
        {account.usage.bySurface.length > 0 && (
          <p className="text-xs text-neutral-500">
            By surface: {formatBySurface(account.usage.bySurface)}
          </p>
        )}
        {account.usage.byCourse.length > 0 && (
          <ul className="flex flex-col gap-1">
            {account.usage.byCourse.map((entry) => (
              <li key={entry.courseId} className="text-xs text-neutral-500">
                <AppLink
                  to={{ kind: 'admin-course', courseId: entry.courseId }}
                  navigate={navigate}
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {entry.courseTitle}
                </AppLink>{' '}
                — {formatMicros(entry.totalCostMicros)} · {entry.callCount}{' '}
                call(s)
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* WEB-72 — the last section on the screen, visibly separated,
          holding this account's own delete and nothing else. */}
      <section
        aria-label="Danger zone"
        className="flex flex-col gap-3 rounded-md border border-danger-600 bg-danger-50 p-4"
      >
        <h3 className="text-section-title font-semibold text-danger-700">
          Danger zone
        </h3>
        <Button
          variant="destructive"
          icon={<DeleteIcon aria-hidden="true" className="size-4" />}
          onClick={() => onDelete(account.accountId, account.displayName)}
          disabled={deletingId === account.accountId}
        >
          {deletingId === account.accountId ? 'Deleting…' : 'Delete account'}
        </Button>
      </section>
    </div>
  )
}
