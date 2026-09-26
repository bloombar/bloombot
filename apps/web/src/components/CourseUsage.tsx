/**
 * WEB-63 — a course's own Usage tab (`pages/CourseEditor.tsx`): this
 * course's spend, its call count, the same per-surface breakdown
 * (`BySurfaceList`, COST-7) `pages/Usage.tsx` shows, and the students
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
 *
 * **WEB-77/WEB-78 — the same person/surface/date filter row `pages/Usage.tsx`
 * carries**, applied server-side the same way: `appliedFilters` is only
 * ever updated by "Apply filters", and `useOrganizationUsageReport`
 * re-fetches whenever it changes. The Student select lists only people with
 * usage *in this course* — `report.people` filtered by `courseIds`, unlike
 * the organization tab's own unfiltered list, since a person this course
 * has never seen is not a meaningful filter to offer here.
 */

import { useState } from 'react'

import type { OrganizationUsageFilters } from '../api/client.js'
import { dayEnd, dayStart } from '../day-boundary.js'
import { surfaceLabel, TRANSCRIPT_SURFACES } from '../surface-label.js'
import { useOrganizationUsageReport } from '../hooks/useOrganizationUsage.js'
import { BySurfaceList } from './BySurfaceList.js'
import { Button } from './Button.js'
import { ErrorMessage } from './ErrorMessage.js'
import { FormField } from './FormField.js'
import { textInputClasses } from './fieldStyles.js'
import { formatMicros, studentLabel } from './usageFormat.js'

export interface CourseUsageProps {
  organizationId: string
  courseId: string
}

export function CourseUsage({ organizationId, courseId }: CourseUsageProps) {
  // WEB-77/WEB-78 — the filter row's own draft values, matching
  // `pages/Usage.tsx`'s own uncontrolled fields: nothing here reaches the
  // server until "Apply filters" is clicked.
  const [filterPersonId, setFilterPersonId] = useState('')
  const [filterSurface, setFilterSurface] = useState<
    '' | 'discord' | 'web' | 'mcp'
  >('')
  const [filterStartDate, setFilterStartDate] = useState('')
  const [filterEndDate, setFilterEndDate] = useState('')
  const [appliedFilters, setAppliedFilters] =
    useState<OrganizationUsageFilters>({})

  const { report, loadError } = useOrganizationUsageReport(
    organizationId,
    appliedFilters
  )

  const handleApplyFilters = () => {
    const startAt = dayStart(filterStartDate)
    const endAt = dayEnd(filterEndDate)
    setAppliedFilters({
      ...(filterPersonId ? { personId: filterPersonId } : {}),
      ...(filterSurface ? { surface: filterSurface } : {}),
      ...(startAt !== undefined ? { from: startAt } : {}),
      ...(endAt !== undefined ? { to: endAt } : {}),
    })
  }

  if (loadError) {
    return <ErrorMessage error={loadError} />
  }

  const course = report?.courses.find((entry) => entry.courseId === courseId)
  const nearLimit =
    report?.studentsNearLimit.filter((entry) => entry.courseId === courseId) ??
    []
  // WEB-77 — this course's own people only, not the organization's whole
  // list (`pages/Usage.tsx`'s own module comment on why that screen's own
  // Student select is unfiltered by course).
  const coursePeople = (report?.people ?? []).filter((person) =>
    person.courseIds.includes(courseId)
  )

  return (
    <div className="flex flex-col gap-6" data-testid="course-usage">
      <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4 sm:flex-row sm:items-end">
        <FormField label="Student">
          <select
            aria-label="Student"
            value={filterPersonId}
            onChange={(event) => setFilterPersonId(event.target.value)}
            className={textInputClasses}
          >
            <option value="">Every student</option>
            {coursePeople.map((person) => (
              <option key={person.personId} value={person.personId}>
                {person.personDisplayName ?? person.personId}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Surface">
          <select
            aria-label="Surface"
            value={filterSurface}
            onChange={(event) =>
              setFilterSurface(event.target.value as typeof filterSurface)
            }
            className={textInputClasses}
          >
            <option value="">Any surface</option>
            {TRANSCRIPT_SURFACES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {surfaceLabel(candidate)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="From">
          <input
            aria-label="From date"
            type="date"
            value={filterStartDate}
            onChange={(event) => setFilterStartDate(event.target.value)}
            className={textInputClasses}
          />
        </FormField>
        <FormField label="To">
          <input
            aria-label="To date"
            type="date"
            value={filterEndDate}
            onChange={(event) => setFilterEndDate(event.target.value)}
            className={textInputClasses}
          />
        </FormField>
        <Button variant="primary" onClick={handleApplyFilters}>
          Apply filters
        </Button>
      </div>

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
