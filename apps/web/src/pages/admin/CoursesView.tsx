/**
 * WEB-33's `'admin-courses'` screen — pending courses first, each with an
 * Approve button, then approved courses with an Unapprove one. Since
 * ADMIN-6, a row's own title is a link into `'admin-course'`.
 */

import type { AdminCourseSummary } from '../../api/types.js'
import { Button } from '../../components/Button.js'
import { LoadingStatus, SkeletonRow } from '../../components/Skeleton.js'

export function CoursesView({
  courses,
  failed,
  decidingCourseId,
  onOpen,
  onApprove,
  onUnapprove,
  onBack,
}: {
  courses: AdminCourseSummary[] | undefined
  /** See `OrganizationsList`'s own `failed` — same reason, same treatment. */
  failed: boolean
  decidingCourseId: string | undefined
  /** ADMIN-6 — a row's own title, clicked. */
  onOpen: (courseId: string) => void
  onApprove: (courseId: string) => void
  onUnapprove: (course: { courseId: string; courseTitle: string }) => void
  onBack: () => void
}) {
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

  const pending = courses.filter((course) => course.aiApprovedAt === null)
  const approved = courses.filter((course) => course.aiApprovedAt !== null)

  return (
    <div className="flex flex-col gap-4">
      <Button variant="secondary" onClick={onBack}>
        ← Organizations
      </Button>
      <h2 className="text-sm font-semibold text-neutral-900">
        Pending approval
      </h2>
      {pending.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No courses awaiting approval.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="admin-courses-pending">
          {pending.map((course) => (
            <li
              key={course.courseId}
              data-testid={`admin-course-${course.courseId}`}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <CourseRowDetail course={course} onOpen={onOpen} />
              <Button
                variant="primary"
                onClick={() => onApprove(course.courseId)}
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
        <p className="text-sm text-neutral-500">No approved courses yet.</p>
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
              <CourseRowDetail course={course} onOpen={onOpen} />
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

/** WEB-53's own identifying detail for one course row — title, project, organization, owner(s) and when created, plus (for an approved course) who approved it and when. Shared between the pending and approved lists above, the same "one row shape, two action columns" the `<Button>` alone differs between. ADMIN-6 — the title is a link into `'admin-course'`, the same underlined-button-as-link treatment `OrganizationsList`'s own name already uses for `'admin-organization'`. */
function CourseRowDetail({
  course,
  onOpen,
}: {
  course: AdminCourseSummary
  onOpen: (courseId: string) => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onOpen(course.courseId)}
        className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        {course.courseTitle}
      </button>
      <p className="text-xs text-neutral-500">
        {course.projectName} · {course.organizationName}
        {course.ownerEmails.length > 0 && ` · ${course.ownerEmails.join(', ')}`}
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
