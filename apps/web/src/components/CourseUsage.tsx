/**
 * WEB-63 — a course's own Usage tab (`pages/CourseEditor.tsx`): this
 * course's spend, its call count, its per-surface breakdown
 * (`BySurfaceList`, COST-7), and the students approaching *this* course's
 * own daily limit today. No spending-cap form — that is the organization's
 * own, owner-only control (`pages/Usage.tsx`); it has no place here.
 *
 * There is no course-scoped usage read — `costLedger.organizationUsage`
 * only ever reports the whole organization (`useOrganizationUsageReport`,
 * the same fetch `pages/Usage.tsx` itself makes) — so this filters that
 * same report down to `courseId`.
 *
 * WEB-77/WEB-78 — the same person/surface/date filter row `pages/Usage.tsx`
 * carries, via the shared `components/UsageFilterRow.tsx`, applied
 * server-side. The Student select lists only people with usage *in this
 * course* (`report.people` filtered by `courseIds`) — a person this course
 * has never seen is not a meaningful filter to offer here, unlike the
 * organization tab's own unfiltered list.
 */

import { useState } from 'react'

import type { OrganizationUsageFilters } from '../api/client.js'
import { useOrganizationUsageReport } from '../hooks/useOrganizationUsage.js'
import { BySurfaceList } from './BySurfaceList.js'
import { ErrorMessage } from './ErrorMessage.js'
import { UsageFilterRow } from './UsageFilterRow.js'
import { formatMicros, studentLabel } from './usageFormat.js'

export interface CourseUsageProps {
  organizationId: string
  courseId: string
}

export function CourseUsage({ organizationId, courseId }: CourseUsageProps) {
  const [appliedFilters, setAppliedFilters] =
    useState<OrganizationUsageFilters>({})
  const isFiltered = Object.keys(appliedFilters).length > 0

  const { report, loadError } = useOrganizationUsageReport(
    organizationId,
    appliedFilters
  )

  const course = report?.courses.find((entry) => entry.courseId === courseId)
  const nearLimit =
    report?.studentsNearLimit.filter((entry) => entry.courseId === courseId) ??
    []
  // WEB-77 — this course's own people only, not the organization's whole
  // list.
  const coursePeople = (report?.people ?? []).filter((person) =>
    person.courseIds.includes(courseId)
  )

  return (
    <div className="flex flex-col gap-6" data-testid="course-usage">
      <UsageFilterRow
        people={coursePeople}
        isFiltered={isFiltered}
        onApply={setAppliedFilters}
        onClear={() => setAppliedFilters({})}
      />

      {/* Round 2, must-fix 3 — beneath the filter row, not replacing the
          whole tab. */}
      {loadError && <ErrorMessage error={loadError} />}

      <section aria-label="Usage" className="flex flex-col gap-2">
        {report && !course && (
          <p className="text-sm text-neutral-500">No usage recorded yet.</p>
        )}
        {course && (
          <>
            <p className="text-sm text-neutral-700">
              {isFiltered ? 'Filtered total' : 'Total'}:{' '}
              {formatMicros(course.costMicros)} · {course.callCount}{' '}
              {course.callCount === 1 ? 'call' : 'calls'}
              {/* COST-6: an estimate is never presented as a measurement. */}
              {course.estimatedCostMicros > 0 && ' · includes an estimate'}
            </p>
            {course.bySurface.length > 0 && (
              <div className="text-sm text-neutral-500">
                <p>By surface:</p>
                <BySurfaceList
                  bySurface={course.bySurface}
                  className="list-disc pl-5"
                />
              </div>
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
