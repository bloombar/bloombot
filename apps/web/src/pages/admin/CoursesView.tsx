/**
 * WEB-33's `'admin-courses'` screen — pending courses first, each with an
 * Approve button, then approved courses with an Unapprove one. Since
 * ADMIN-6, a row's own title is a link into `'admin-course'`.
 *
 * ADMIN-12 — one search field above both lists, matching a course's title,
 * project, organization or owner email; it filters `pending` and
 * `approved` together (both are `.filter()`d from the one already-searched
 * list below), so typing "Fall 2026" narrows whichever of the two lists
 * actually has a row from that project, not only one of them.
 *
 * ADMIN-13 — Approve and Unapprove both confirm through this panel's one
 * modal before sending anything (`Admin.tsx`'s own `handleApprove`/
 * `handleUnapprove` — this screen only renders the buttons that call
 * them, the confirmation itself lives where the request is made, so both
 * this list and the course's own screen, `CourseDetailView`, share the
 * identical confirmed decision rather than each dialoguing separately).
 */

import type { AdminCourseSummary } from '../../api/types.js'
import { AppLink } from '../../components/AppLink.js'
import { Button } from '../../components/Button.js'
import { LoadingStatus, SkeletonRow } from '../../components/Skeleton.js'
import type { Route } from '../../routing/route.js'
import { SearchField, useListSearch } from './SearchField.js'

export function CoursesView({
  courses,
  failed,
  decidingCourseId,
  navigate,
  onApprove,
  onUnapprove,
  onBack,
}: {
  courses: AdminCourseSummary[] | undefined
  /** See `OrganizationsList`'s own `failed` — same reason, same treatment. */
  failed: boolean
  decidingCourseId: string | undefined
  navigate: (route: Route, options?: { replace?: boolean }) => void
  // ADMIN-13 — the whole course, not only its id: `Admin.tsx`'s own
  // `handleApprove` names the course in its own confirmation, the same
  // shape `onUnapprove` below already takes.
  onApprove: (course: { courseId: string; courseTitle: string }) => void
  onUnapprove: (course: { courseId: string; courseTitle: string }) => void
  onBack: () => void
}) {
  // ADMIN-12 — title, project, organization or owner email, joined into
  // one string this hook's own single substring test matches against.
  const search = useListSearch(
    courses,
    (course) =>
      `${course.courseTitle} ${course.projectName} ${course.organizationName} ${course.owners.map((owner) => owner.email).join(' ')}`
  )

  if (courses === undefined) {
    if (failed) {
      return (
        <Button variant="secondary" onClick={onBack}>
          ← Organizations
        </Button>
      )
    }
    // WEB-45: shaped like the `<li>` rows below, once the read resolves.
    return (
      <div className="flex flex-col gap-3">
        <SkeletonRow />
        <SkeletonRow />
        <LoadingStatus />
      </div>
    )
  }

  const filtered = search.filtered ?? []
  const pending = filtered.filter((course) => course.aiApprovedAt === null)
  const approved = filtered.filter((course) => course.aiApprovedAt !== null)

  return (
    <div className="flex flex-col gap-4">
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>

      {courses.length > 0 && (
        <SearchField
          id="admin-courses"
          label="Search courses"
          placeholder="Search by title, project, organization or owner"
          query={search.query}
          onChange={search.setQuery}
          matchCount={search.matchCount}
          totalCount={search.totalCount}
          itemLabel="courses"
        />
      )}

      <h2 className="text-sm font-semibold text-neutral-900">
        Pending approval
      </h2>
      {pending.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {/* ADMIN-12: distinguishes "nothing pending at all" from "a
              search narrowed it to nothing," the same way `approved`
              below does. */}
          {search.query !== ''
            ? `No pending courses match “${search.query}”.`
            : 'No courses awaiting approval.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="admin-courses-pending">
          {pending.map((course) => (
            <li
              key={course.courseId}
              data-testid={`admin-course-${course.courseId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <CourseRowDetail course={course} navigate={navigate} />
              <Button
                variant="primary"
                onClick={() => onApprove(course)}
                disabled={decidingCourseId === course.courseId}
              >
                {decidingCourseId === course.courseId
                  ? 'Approving…'
                  : 'Approve'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="text-sm font-semibold text-neutral-900">Approved</h2>
      {approved.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {search.query !== ''
            ? `No approved courses match “${search.query}”.`
            : 'No approved courses yet.'}
        </p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          data-testid="admin-courses-approved"
        >
          {approved.map((course) => (
            <li
              key={course.courseId}
              data-testid={`admin-course-${course.courseId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <CourseRowDetail course={course} navigate={navigate} />
              <Button
                variant="destructive"
                onClick={() => onUnapprove(course)}
                disabled={decidingCourseId === course.courseId}
              >
                {decidingCourseId === course.courseId
                  ? 'Unapproving…'
                  : 'Unapprove'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * WEB-53's own identifying detail for one course row — title, project,
 * organization, owner(s) and when created, plus (for an approved course)
 * who approved it and when. Shared between the pending and approved lists
 * above, the same "one row shape, two action columns" the `<Button>`
 * alone differs between.
 *
 * ADMIN-6 — the title is a link into `'admin-course'`. ADMIN-12/ADMIN-7 —
 * the project, the organization and every owner are now links too (into
 * `'admin-project'`, `'admin-organization'` and `'admin-account'`
 * respectively), the same "every entity named here is a real link"
 * treatment `OrganizationsList` already gives its own rows — the last gap
 * two reviews flagged, closed by `AdminCourseSummary` (`courseApproval.CourseForApproval`,
 * `packages/db`) now carrying `projectId` and each owner's `accountId`
 * alongside its name/email (`docs/DECISIONS.md` D-130).
 */
function CourseRowDetail({
  course,
  navigate,
}: {
  course: AdminCourseSummary
  navigate: (route: Route, options?: { replace?: boolean }) => void
}) {
  return (
    <div>
      <AppLink
        to={{ kind: 'admin-course', courseId: course.courseId }}
        navigate={navigate}
        className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        {course.courseTitle}
      </AppLink>
      <p className="text-xs text-neutral-500">
        <AppLink
          to={{ kind: 'admin-project', projectId: course.projectId }}
          navigate={navigate}
          className="text-brand-700 underline-offset-2 hover:underline"
        >
          {course.projectName}
        </AppLink>{' '}
        ·{' '}
        <AppLink
          to={{
            kind: 'admin-organization',
            organizationId: course.organizationId,
          }}
          navigate={navigate}
          className="text-brand-700 underline-offset-2 hover:underline"
        >
          {course.organizationName}
        </AppLink>
        {course.owners.length > 0 && (
          <>
            {' · '}
            {course.owners.map((owner, index) => (
              <span key={owner.accountId}>
                {index > 0 && ', '}
                <AppLink
                  to={{ kind: 'admin-account', accountId: owner.accountId }}
                  navigate={navigate}
                  className="text-brand-700 underline-offset-2 hover:underline"
                >
                  {owner.email}
                </AppLink>
              </span>
            ))}
          </>
        )}
      </p>
      <p className="text-xs text-neutral-400">
        Created {new Date(course.createdAt).toLocaleString()}
        {course.aiApprovedAt !== null &&
          ` · approved ${new Date(course.aiApprovedAt).toLocaleString()}${
            course.aiApprovedByEmail ? ` by ${course.aiApprovedByEmail}` : ''
          }`}
      </p>
    </div>
  )
}
