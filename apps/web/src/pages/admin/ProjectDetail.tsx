/**
 * ADMIN-8 — a project's own console screen: its name, its organization (a
 * link back to ADMIN-7's screen), when it was created, whether it is
 * archived, and its courses — each with its approval state, its enrolment
 * count, its usage, and a link to the course's own screen (ADMIN-9).
 * Fetched with `fetchAdminProject(id)`; `NotFound` renders for
 * `project_not_found` (404), the same treatment `admin-organization` and
 * `admin-course` already give an unknown id.
 *
 * WEB-72/DATA-7 — a Danger zone, last on the screen: a platform
 * administrator's own soft-delete, reversible for the deployment's
 * retention window, then permanent. `Admin.tsx#handleSoftDelete` gates it
 * on typing the project's own name, the same typed-name discipline
 * `Admin.tsx#handleDelete` (ADMIN-5) already applies to an organization —
 * this screen only renders the button and reports `deletingId`.
 */

import type { AdminProjectDetail } from '../../api/types.js'
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
import { formatMicros, ReadOnlyField } from './shared.js'

export function ProjectDetail({
  projectId,
  project,
  notFound,
  failed,
  deletingId,
  navigate,
  onDelete,
  onBack,
}: {
  projectId: string
  project: AdminProjectDetail | undefined
  /** ADMIN-8 — this project id 404'd, distinct from `failed`. */
  notFound: boolean
  failed: boolean
  /** WEB-72/DATA-7 — the project id currently mid-delete, the same `deletingId` shape `admin/OrganizationDetail.tsx` already uses for ADMIN-5. */
  deletingId: string | undefined
  navigate: (route: Route, options?: { replace?: boolean }) => void
  onDelete: (projectId: string, name: string) => void
  onBack: () => void
}) {
  if (notFound) {
    return <NotFound onHome={onBack} />
  }

  if (project === undefined || project.projectId !== projectId) {
    if (failed) {
      return (
        <Button variant="secondary" onClick={onBack}>
          ← Organizations
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
      data-testid={`admin-project-detail-${project.projectId}`}
    >
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>

      <div>
        <p className="text-xs font-medium text-neutral-500">Project</p>
        <h2 className="text-page-title font-semibold text-neutral-900">
          {project.name}
        </h2>
      </div>

      <dl className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <dt className="w-48 shrink-0 text-xs font-medium text-neutral-500">
            Organization
          </dt>
          <dd className="text-sm text-neutral-900">
            <AppLink
              to={{
                kind: 'admin-organization',
                organizationId: project.organizationId,
              }}
              navigate={navigate}
              className="font-medium text-brand-700 underline-offset-2 hover:underline"
            >
              {project.organizationName}
            </AppLink>
          </dd>
        </div>
        <ReadOnlyField
          label="Created"
          value={new Date(project.createdAt).toLocaleString()}
        />
        <ReadOnlyField
          label="Archived"
          value={
            project.archivedAt === null
              ? 'No'
              : `Yes, ${new Date(project.archivedAt).toLocaleString()}`
          }
        />
      </dl>

      <section
        aria-label="Courses"
        className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4"
      >
        <h3 className="text-section-title font-semibold text-neutral-900">
          Courses
        </h3>
        {project.courses.length === 0 ? (
          <p className="text-sm text-neutral-500">No courses yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs font-medium text-neutral-500">
                  <th className="py-1 pr-4">Course</th>
                  <th className="py-1 pr-4">Approval</th>
                  <th className="py-1 pr-4">Enrolled</th>
                  <th className="py-1">Cost</th>
                </tr>
              </thead>
              <tbody>
                {project.courses.map((course) => (
                  <tr
                    key={course.courseId}
                    className="border-t border-neutral-100"
                  >
                    <td className="py-1 pr-4">
                      <AppLink
                        to={{ kind: 'admin-course', courseId: course.courseId }}
                        navigate={navigate}
                        className="font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        {course.title}
                      </AppLink>
                    </td>
                    <td className="py-1 pr-4 text-neutral-700">
                      {course.aiApprovedAt === null
                        ? 'Pending approval'
                        : 'Approved'}
                    </td>
                    <td className="py-1 pr-4 text-neutral-700">
                      {course.enrolmentCount}
                    </td>
                    <td className="py-1 text-neutral-700">
                      {formatMicros(course.totalCostMicros)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* WEB-72 — the last section on the screen, visibly separated,
          holding this project's own delete and nothing else. */}
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
          onClick={() => onDelete(project.projectId, project.name)}
          disabled={deletingId === project.projectId}
        >
          {deletingId === project.projectId ? 'Deleting…' : 'Delete project'}
        </Button>
      </section>
    </div>
  )
}
