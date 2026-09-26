/**
 * WEB-77/WEB-78 — the person/surface/date filter row `pages/Usage.tsx` and
 * `components/CourseUsage.tsx` both need, extracted (round 2, must-fix 7)
 * so the same Student/Surface/date/Apply behaviour — and the same
 * client-side validation and "Clear filters" control — lives in one place
 * rather than two screens each keeping their own copy in step by hand.
 *
 * Mirrors `components/TranscriptBrowser.tsx`'s own filter row shape: a
 * Student select, a Surface select defaulting to "Any surface", two
 * `type="date"` inputs, and an explicit "Apply filters" button rather than
 * a fetch on every keystroke. `onApply` is called with the filters object
 * to send only once a click passes validation (`dateRangeError`,
 * `day-boundary.ts`) — round 2, must-fix 3: a date before 1970 or a "From"
 * after "To" used to reach the server, fail there, and replace the whole
 * screen with an error this row was no longer even visible to fix from.
 * `onApply`/`onClear` are both always genuine, fresh requests (round 2,
 * must-fix 11/2) — a caller's own hook re-fetches on every call, even one
 * whose filters are unchanged from the last, which is what an explicit
 * "Apply" click should mean.
 */

import { useState } from 'react'

import type { OrganizationUsageFilters } from '../api/client.js'
import type { OrganizationUsagePerson } from '../api/types.js'
import { dateRangeError, dayEnd, dayStart } from '../day-boundary.js'
import { surfaceLabel, TRANSCRIPT_SURFACES } from '../surface-label.js'
import { studentLabel } from './usageFormat.js'
import { Button } from './Button.js'
import { FormField } from './FormField.js'
import { textInputClasses } from './fieldStyles.js'

export interface UsageFilterRowProps {
  /** Whom the Student select offers — the organization tab's own whole list, or the course tab's own list narrowed to that course's own people. */
  people: OrganizationUsagePerson[]
  /** Whether at least one filter is currently applied — decides whether "Clear filters" and the "Showing filtered results" note render. */
  isFiltered: boolean
  onApply: (filters: OrganizationUsageFilters) => void
  onClear: () => void
}

export function UsageFilterRow({
  people,
  isFiltered,
  onApply,
  onClear,
}: UsageFilterRowProps) {
  const [personId, setPersonId] = useState('')
  const [surface, setSurface] = useState<'' | 'discord' | 'web' | 'mcp'>('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [rangeError, setRangeError] = useState<string | undefined>(undefined)

  const handleApply = () => {
    const error = dateRangeError(startDate, endDate)
    if (error) {
      setRangeError(error)
      return
    }
    setRangeError(undefined)
    const startAt = dayStart(startDate)
    const endAt = dayEnd(endDate)
    onApply({
      ...(personId ? { personId } : {}),
      ...(surface ? { surface } : {}),
      ...(startAt !== undefined ? { from: startAt } : {}),
      ...(endAt !== undefined ? { to: endAt } : {}),
    })
  }

  const handleClear = () => {
    setPersonId('')
    setSurface('')
    setStartDate('')
    setEndDate('')
    setRangeError(undefined)
    onClear()
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <FormField label="Student">
          <select
            aria-label="Student"
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
            className={textInputClasses}
          >
            <option value="">Every student</option>
            {people.map((person) => (
              <option key={person.personId} value={person.personId}>
                {studentLabel(person)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Surface">
          <select
            aria-label="Surface"
            value={surface}
            onChange={(event) =>
              setSurface(event.target.value as typeof surface)
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
        <FormField label="From" {...(rangeError ? { error: rangeError } : {})}>
          <input
            aria-label="From date"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            className={textInputClasses}
          />
        </FormField>
        <FormField label="To">
          <input
            aria-label="To date"
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className={textInputClasses}
          />
        </FormField>
        <Button variant="primary" onClick={handleApply}>
          Apply filters
        </Button>
        {isFiltered && (
          <Button variant="secondary" onClick={handleClear}>
            Clear filters
          </Button>
        )}
      </div>
      {isFiltered && (
        <p role="status" className="text-xs text-neutral-500">
          Showing filtered results.
        </p>
      )}
    </div>
  )
}
