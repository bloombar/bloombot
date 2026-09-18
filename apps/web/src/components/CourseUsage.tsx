/**
 * WEB-63 — a course's own Usage tab (`pages/CourseEditor.tsx`): this
 * course's spend, its call count, the same per-surface breakdown
 * (`formatBySurface`, COST-7) `pages/Usage.tsx` shows, and the students
 * approaching *this* course's own daily limit today. No spending-cap form —
 * that is the organization's own, owner-only control
 * (`pages/Usage.tsx`'s own module comment on why it is withheld from
 * anyone but an owner); it has no place on a screen about one course.
 *
 * There is no course-scoped usage read — `costLedger.organizationUsage`
 * only ever reports the whole organization (`useOrganizationUsageReport`,
 * the same fetch `pages/Usage.tsx` itself makes) — so this filters that
 * same report down to `courseId` rather than adding a second action or
 * route for a course-scoped version of a read this app already has.
 */

import { useOrganizationUsageReport } from '../hooks/useOrganizationUsage.js'
import { ErrorMessage } from './ErrorMessage.js'
import { formatBySurface, formatMicros, studentLabel } from './usageFormat.js'

export interface CourseUsageProps {
  organizationId: string
  courseId: string
}

export function CourseUsage({ organizationId, courseId }: CourseUsageProps) {
  const { report, loadError } = useOrganizationUsageReport(organizationId)

  if (loadError) {
    return <ErrorMessage error={loadError} />
  }

  const course = report?.courses.find((entry) => entry.courseId === courseId)
  const nearLimit =
    report?.studentsNearLimit.filter((entry) => entry.courseId === courseId) ??
    []

  return (
    <div className="flex flex-col gap-6" data-testid="course-usage">
      <section aria-label="Usage" className="flex flex-col gap-2">
        {report && !course && (
          <p className="text-sm text-neutral-500">No usage recorded yet.</p>
        )}
        {course && (
          <>
            <p className="text-sm text-neutral-700">
              {formatMicros(course.costMicros)} · {course.callCount}{' '}
              {course.callCount === 1 ? 'call' : 'calls'}
              {/* COST-6: an estimate is never presented as a measurement —
                  said plainly whenever any part of this course's own total
                  came from one, the same as `pages/Usage.tsx`'s own
                  per-course row. */}
              {course.estimatedCostMicros > 0 && ' · includes an estimate'}
            </p>
            {course.bySurface.length > 0 && (
              <p className="text-sm text-neutral-500">
                By surface: {formatBySurface(course.bySurface)}
              </p>
            )}
          </>
        )}
      </section>

      <section
        aria-label="Students approaching their limit today"
        className="flex flex-col gap-2"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Students approaching their limit today
        </h2>
        {report && nearLimit.length === 0 && (
          <p className="text-sm text-neutral-500">
            Nobody is close to this course&apos;s own daily limit today.
          </p>
        )}
        {nearLimit.length > 0 && (
          <ul className="flex flex-col gap-2">
            {nearLimit.map((entry) => (
              <li
                key={entry.personId}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
              >
                <p className="text-sm font-medium text-neutral-900">
                  {studentLabel(entry)}
                </p>
                <p className="text-sm text-neutral-500">
                  {entry.count} of {entry.maxRequestsPerDay} today
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
