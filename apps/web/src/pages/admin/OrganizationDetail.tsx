/**
 * ADMIN-7 — one organization's own console screen, a full page rather than
 * an expanded list row: name, created, personal-or-not, spending cap,
 * usage (total cost, calls, by surface — COST-7), the accounts that own it,
 * its full membership with roles, then its projects, each listing its own
 * courses with approval state, enrolment count and cost. Every project,
 * course and owner named here links to that entity's own console screen
 * (`AppLink`, ADMIN-8/ADMIN-9/ADMIN-11).
 *
 * Fetched with `fetchAdminOrganization(id)` (`Admin.tsx`'s own
 * `refreshOrganizationDetail`), replacing the pre-ADMIN-7 version that
 * `.find()`d a row out of `fetchAdminOrganizations()`'s own list — that list
 * never carried a project, a course or a member at all, so there was
 * nothing in it this richer screen could have read from. `NotFound` renders
 * for `organization_not_found` (404), the same treatment `admin-course`
 * already gives an unknown course id.
 */

import type { AdminOrganizationDetail } from '../../api/types.js'
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

export function OrganizationDetail({
  organizationId,
  organization,
  notFound,
  failed,
  deletingId,
  navigate,
  onDelete,
  onBack,
}: {
  organizationId: string
  organization: AdminOrganizationDetail | undefined
  /** ADMIN-7 — this organization id 404'd, distinct from `failed` (a refusal, e.g. 403) below: this renders `NotFound`, `failed` renders nothing further (the top-level `ErrorMessage` already has it). */
  notFound: boolean
  failed: boolean
  deletingId: string | undefined
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onDelete: (organizationId: string, name: string) => void
  onBack: () => void
}) {
  if (notFound) {
    return <NotFound onHome={onBack} />
  }

  // A stale read from the *previous* address — `organization.organizationId
  // !== organizationId` — must not flash under the new one for one render,
  // the same guard `admin-course`'s own detail screen already holds itself
  // to.
  if (
    organization === undefined ||
    organization.organizationId !== organizationId
  ) {
    if (failed) {
      return (
        <Button variant="secondary" onClick={onBack}>
          ← Organizations
        </Button>
      )
    }
    // WEB-45: shaped like the settled screen below, once the read resolves.
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
      data-testid={`admin-org-detail-${organization.organizationId}`}
    >
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium text-neutral-500">Organization</p>
          <h2 className="text-page-title font-semibold text-neutral-900">
            {organization.name}
          </h2>
        </div>
        <Button
          variant="destructive"
          icon={<DeleteIcon aria-hidden="true" className="size-4" />}
          onClick={() =>
            onDelete(organization.organizationId, organization.name)
          }
          disabled={deletingId === organization.organizationId}
        >
          {deletingId === organization.organizationId ? 'Deleting…' : 'Delete'}
        </Button>
      </div>

      <dl className="flex flex-col gap-2">
        <ReadOnlyField
          label="Created"
          value={new Date(organization.createdAt).toLocaleString()}
        />
        <ReadOnlyField
          label="Personal organization"
          value={organization.isPersonal ? 'Yes' : 'No'}
        />
        <ReadOnlyField
          label="Spending cap"
          value={
            organization.spendingCapMicros === null
              ? 'None'
              : formatMicros(organization.spendingCapMicros)
          }
        />
      </dl>

      <section
        aria-label="Usage"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Usage
        </h3>
        <p className="text-sm text-neutral-900">
          {formatMicros(organization.usage.totalCostMicros)} spent ·{' '}
          {organization.usage.callCount} call(s)
          {organization.usage.hasEstimated && ' · partly estimated'}
        </p>
        {organization.usage.bySurface.length > 0 && (
          <p className="text-xs text-neutral-500">
            By surface: {formatBySurface(organization.usage.bySurface)}
          </p>
        )}
      </section>

      <section
        aria-label="Owners"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Owners
        </h3>
        {organization.owners.length === 0 ? (
          <p className="text-sm text-neutral-500">No owners.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {organization.owners.map((owner) => (
              <li key={owner.accountId} className="text-sm">
                <AppLink
                  to={{ kind: 'admin-account', accountId: owner.accountId }}
                  navigate={navigate}
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {owner.displayName}
                </AppLink>{' '}
                <span className="text-neutral-500">{owner.email}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="Members"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Members
        </h3>
        {organization.members.length === 0 ? (
          <p className="text-sm text-neutral-500">No members.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs font-medium text-neutral-500">
                  <th className="py-1 pr-4">Name</th>
                  <th className="py-1 pr-4">Role</th>
                  <th className="py-1">Since</th>
                </tr>
              </thead>
              <tbody>
                {organization.members.map((member) => (
                  <tr
                    key={member.accountId}
                    className="border-t border-neutral-100"
                  >
                    <td className="py-1 pr-4">
                      <AppLink
                        to={{
                          kind: 'admin-account',
                          accountId: member.accountId,
                        }}
                        navigate={navigate}
                        className="font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        {member.displayName}
                      </AppLink>
                    </td>
                    <td className="py-1 pr-4 text-neutral-700">
                      {member.role}
                    </td>
                    <td className="py-1 text-neutral-500">
                      {member.grantedAt === null
                        ? '—'
                        : new Date(member.grantedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        aria-label="Projects"
        className="flex flex-col gap-4 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Projects
        </h3>
        {organization.projects.length === 0 ? (
          <p className="text-sm text-neutral-500">No projects yet.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {organization.projects.map((project) => (
              <li
                key={project.projectId}
                className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3"
              >
                <AppLink
                  to={{ kind: 'admin-project', projectId: project.projectId }}
                  navigate={navigate}
                  className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  {project.name}
                </AppLink>
                {project.courses.length === 0 ? (
                  <p className="text-xs text-neutral-500">No courses yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1 pl-4">
                    {project.courses.map((course) => (
                      <li key={course.courseId} className="text-xs">
                        <AppLink
                          to={{
                            kind: 'admin-course',
                            courseId: course.courseId,
                          }}
                          navigate={navigate}
                          className="font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          {course.title}
                        </AppLink>{' '}
                        <span className="text-neutral-500">
                          ·{' '}
                          {course.aiApprovedAt === null
                            ? 'Pending approval'
                            : 'Approved'}{' '}
                          · {course.enrolmentCount} enrolled ·{' '}
                          {formatMicros(course.totalCostMicros)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
