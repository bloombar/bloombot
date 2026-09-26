/**
 * COST-3/COST-4 — an instructor's own usage screen: what their courses have
 * spent, which students are approaching a course's own daily limit today,
 * and the organization's own spending cap, settable (or clearable) right
 * here.
 *
 * **Three visually distinct states for the cap**, not a shared "here is a
 * number" treatment — COST-3's own enforcement stops the assistant
 * answering the moment a cap is reached, so an instructor reading this
 * screen needs "no cap at all," "a cap that has room left," and "a cap that
 * has stopped the assistant" to look nothing alike. "Cap reached" compares
 * the same two numbers `@bloombot/db`'s own `hasReachedSpendingCap` does
 * (`spent >= cap`), always against `unfilteredTotalCostMicros` (WEB-78) —
 * never `totalCostMicros`, which a filter below can narrow — so a filter
 * can never make the cap look like it has more or less room than it does.
 *
 * **Setting a cap is owner-only.** `isOwner` decides whether the cap form
 * renders at all — the server's own check
 * (`costLedger.setSpendingCap`) is what actually enforces this; this only
 * avoids offering a click that would refuse.
 *
 * **No email, ever.** Every student name here goes through
 * `components/usageFormat.ts#studentLabel` — display name, then first/last
 * name, then the bare id.
 *
 * **WEB-77/WEB-78 — person, surface and date filters, applied
 * server-side**, via the shared `components/UsageFilterRow.tsx`.
 * `appliedFilters` is only ever updated by that row's own "Apply
 * filters"/"Clear filters", each a fresh fetch (`useOrganizationUsageReport`'s
 * own doc comment). `report.totalCostMicros`/`courses`/`bySurface` reflect
 * whatever is applied; `report.unfilteredTotalCostMicros` never does.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, setSpendingCap } from '../api/client.js'
import type { OrganizationUsageFilters } from '../api/client.js'
import type { OrganizationUsageReport } from '../api/types.js'
import { AppLink } from '../components/AppLink.js'
import { BySurfaceList } from '../components/BySurfaceList.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'
import { UsageFilterRow } from '../components/UsageFilterRow.js'
import { formatMicros, studentLabel } from '../components/usageFormat.js'
import { useOrganizationUsageReport } from '../hooks/useOrganizationUsage.js'
import type { TabDirtyActions } from '../hooks/tabDirtyActions.js'
import { InfoIcon, WarningIcon } from '../icons.js'
import type { Route } from '../routing/route.js'

export interface UsageScreenProps {
  organizationId: string
  /** Whether the caller's own membership in this organization is `'owner'` — see this file's own module comment for why the form is withheld rather than merely disabled for anyone else. */
  isOwner: boolean
  /** WEB-79 — a course title in "Usage by course" links to that course's own settings, opened at its Usage tab. `pages/Shell.tsx`'s own `navigate`, threaded through `pages/OrganizationSettings.tsx` the same way `components/GeneralSettings.tsx` already receives it — already wrapped in `guardedNavigate` there, so this file calls it directly. */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /**
   * WEB-69 — called on every change to whether this screen's own cap input
   * currently disagrees with the last-saved cap, so
   * `pages/OrganizationSettings.tsx` can fold it into that tab's own dirty
   * flag. Optional, defaulting to a no-op — most of this file's own tests
   * do not care.
   */
  onDirtyChange?: (dirty: boolean) => void
  /** WEB-69 — this tab's own save/discard handle; called with `null` on unmount. Optional — most of this file's own tests do not care. */
  onRegisterActions?: (actions: TabDirtyActions | null) => void
}

/**
 * A cap amount, typed as a currency amount ($12.50), never micros. Blank
 * means "clear the cap" (`null`); anything else must parse as a nonnegative
 * amount with at most two decimal places (cents) — never `NaN`, which would
 * silently be sent as `null` and clear the stored cap instead of refusing.
 */
function parseCapAmount(
  raw: string
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return { ok: false }
  return { ok: true, value }
}

/** `capInput`'s own starting value for a freshly loaded (or refreshed) report — the stored cap, formatted the same way `formatMicros` renders it but without the `$`. */
function capInputFromReport(report: OrganizationUsageReport): string {
  return report.spendingCapMicros === null
    ? ''
    : (report.spendingCapMicros / 1_000_000).toFixed(2)
}

/** Every call in the (filtered) report, summed by surface — covers deleted courses too, so it agrees with `totalCostMicros`. */
function totalCallCount(report: OrganizationUsageReport): number {
  return report.bySurface.reduce((sum, entry) => sum + entry.callCount, 0)
}

export function Usage({
  organizationId,
  isOwner,
  navigate,
  onDirtyChange = () => {},
  onRegisterActions,
}: UsageScreenProps) {
  const [appliedFilters, setAppliedFilters] =
    useState<OrganizationUsageFilters>({})
  const isFiltered = Object.keys(appliedFilters).length > 0

  const {
    report,
    loadError,
    refresh: refreshReport,
  } = useOrganizationUsageReport(organizationId, appliedFilters)

  const [capInput, setCapInput] = useState('')
  const [capParseError, setCapParseError] = useState(false)
  const [saving, setSaving] = useState(false)
  // WEB-69 — read synchronously by `isSaving`, below (`TabDirtyActions`'s
  // own doc comment on why a ref, not the `saving` state, is what a tab
  // prompt that may fire in the same tick as this section's own Save button
  // actually needs).
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState<ApiError | undefined>(undefined)
  // A live region for the one thing a screen reader cannot otherwise learn
  // from this screen's own re-render: the cap badge above changing state
  // after a save or a clear succeeds.
  const [statusMessage, setStatusMessage] = useState<string | undefined>(
    undefined
  )

  // `capInput`'s own starting value tracks the loaded (or refreshed)
  // report's own *cap*, not the report object itself (round 2, must-fix 1):
  // applying a filter fetches a fresh `report` with the identical cap, and
  // the old `[report]` dependency reseeded `capInput` from it every time,
  // silently discarding an owner's own unsaved edit (and the WEB-69 dirty
  // flag with it) the moment a filter was applied. `spendingCapMicros`
  // itself only ever changes on a real save/clear.
  useEffect(() => {
    if (report) setCapInput(capInputFromReport(report))
  }, [report?.spendingCapMicros])

  // WEB-69: returns whether the cap actually saved, so a caller that saves
  // on the way somewhere else (`pages/OrganizationSettings.tsx`'s own tab
  // prompt) knows whether it is safe to move on.
  const handleSave = useCallback(async (): Promise<boolean> => {
    const parsed = parseCapAmount(capInput)
    if (!parsed.ok) {
      setCapParseError(true)
      return false
    }
    setCapParseError(false)
    setSaveError(undefined)
    setStatusMessage(undefined)
    setSaving(true)
    savingRef.current = true
    try {
      await setSpendingCap(organizationId, parsed.value)
      setStatusMessage(
        parsed.value === null
          ? 'Spending cap cleared.'
          : `Spending cap set to ${formatMicros(Math.round(parsed.value * 1_000_000))}.`
      )
      await refreshReport()
      return true
    } catch (caught) {
      if (caught instanceof ApiError) setSaveError(caught)
      else throw caught
      return false
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }, [capInput, organizationId, refreshReport])

  const handleClear = async () => {
    setCapParseError(false)
    setSaveError(undefined)
    setStatusMessage(undefined)
    setSaving(true)
    savingRef.current = true
    try {
      await setSpendingCap(organizationId, null)
      setStatusMessage('Spending cap cleared.')
      await refreshReport()
    } catch (caught) {
      if (caught instanceof ApiError) setSaveError(caught)
      else throw caught
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  // WEB-69 — "dirty" for this tab: the cap input disagrees with the last
  // report this screen actually saw. `undefined` while nothing has loaded
  // yet reads as "not dirty."
  const isDirty =
    report !== undefined && capInput !== capInputFromReport(report)

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  const discard = useCallback(() => {
    if (report) setCapInput(capInputFromReport(report))
    setCapParseError(false)
    setSaveError(undefined)
  }, [report])

  useEffect(() => {
    if (!onRegisterActions) return
    onRegisterActions({
      save: handleSave,
      isSaving: () => savingRef.current,
      discard,
    })
    return () => onRegisterActions(null)
  }, [handleSave, discard, onRegisterActions])

  // COST-3: the same comparison `@bloombot/db`'s own `hasReachedSpendingCap`
  // makes (`spent >= cap`). `unfilteredTotalCostMicros`, not
  // `totalCostMicros` — this file's own module comment on why.
  const capReached =
    report !== undefined &&
    report.spendingCapMicros !== null &&
    report.unfilteredTotalCostMicros >= report.spendingCapMicros

  return (
    <div className="flex flex-col gap-6" data-testid="usage-screen">
      <h1 className="text-page-title font-semibold text-neutral-900">Usage</h1>

      <p role="status" className="sr-only">
        {statusMessage}
      </p>

      <UsageFilterRow
        people={report?.people ?? []}
        isFiltered={isFiltered}
        onApply={setAppliedFilters}
        onClear={() => setAppliedFilters({})}
      />

      {/* Round 2, must-fix 3 — beneath the filter row, not replacing the
          whole screen: a load error must never take the filter row (and any
          way to fix what caused it) off the page. */}
      {loadError && <ErrorMessage error={loadError} />}

      {report && (
        // Round 2, must-fix 4 (SPEC WEB-78) — the totals below the filter
        // row can be narrowed; this line says so plainly rather than
        // leaving a reader to notice the numbers changed.
        <p className="text-sm font-medium text-neutral-700">
          {isFiltered ? 'Filtered total' : 'Total'}:{' '}
          {formatMicros(report.totalCostMicros)} · {totalCallCount(report)}{' '}
          {totalCallCount(report) === 1 ? 'call' : 'calls'}
        </p>
      )}

      <section aria-label="Spending cap" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">Spending cap</h2>

        {report && report.spendingCapMicros === null && (
          <p className="text-sm text-neutral-500">
            No spending cap set — the assistant answers without a spending
            ceiling.
          </p>
        )}
        {report && report.spendingCapMicros !== null && !capReached && (
          // A flat text node alongside the icon, not a wrapping `<span>` —
          // `e2e/spending-cap.spec.ts#readCapMicros`'s own `page.getByText`
          // needs each message as its own element to avoid ambiguity.
          <div className="flex items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
            <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
            Cap set at {formatMicros(report.spendingCapMicros)} —{' '}
            {formatMicros(report.unfilteredTotalCostMicros)} spent so far.
          </div>
        )}
        {report && capReached && report.spendingCapMicros !== null && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-danger-600 bg-danger-50 px-3 py-2 text-sm text-danger-700"
          >
            <WarningIcon aria-hidden="true" className="size-4 shrink-0" />
            Cap reached — {formatMicros(
              report.unfilteredTotalCostMicros
            )} of {formatMicros(report.spendingCapMicros)} spent. The assistant
            will not answer until this is raised or cleared.
          </div>
        )}
        {report && report.bySurface.length > 0 && (
          <div className="text-sm text-neutral-500">
            <p>By surface:</p>
            <BySurfaceList
              bySurface={report.bySurface}
              className="list-disc pl-5"
            />
          </div>
        )}

        {isOwner && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <FormField
                label="Spending cap ($)"
                help="Blank clears the cap — not the same as $0, which blocks every question."
                {...(capParseError
                  ? {
                      error:
                        'Enter a nonnegative amount, e.g. 12.50, or leave blank to clear the cap.',
                    }
                  : {})}
              >
                <input
                  type="text"
                  inputMode="decimal"
                  value={capInput}
                  onChange={(event) => {
                    setCapInput(event.target.value)
                    setCapParseError(false)
                  }}
                  className={textInputClasses}
                />
              </FormField>
            </div>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save cap'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void handleClear()}
              disabled={saving}
            >
              Clear cap
            </Button>
          </div>
        )}
        {saveError && <ErrorMessage error={saveError} />}
      </section>

      <section aria-label="Usage by course" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-900">
          Usage by course
        </h2>
        {report && report.courses.length === 0 && (
          <p className="text-sm text-neutral-500">No courses yet.</p>
        )}
        {report && report.courses.length > 0 && (
          <ul className="flex flex-col gap-2">
            {report.courses.map((course) => (
              <li
                key={course.courseId}
                className="flex flex-col gap-1 rounded-md border border-neutral-200 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  {/* WEB-79 — links to this course's own settings, opened
                      directly at its Usage tab. */}
                  <AppLink
                    to={{
                      kind: 'course-editor',
                      organizationId,
                      projectId: course.projectId,
                      courseId: course.courseId,
                      tab: 'usage',
                    }}
                    navigate={navigate}
                    className="text-sm font-medium text-brand-700 underline"
                  >
                    {course.courseTitle}
                  </AppLink>
                  <p className="text-sm text-neutral-500">
                    {formatMicros(course.costMicros)} · {course.callCount}{' '}
                    {course.callCount === 1 ? 'call' : 'calls'}
                    {/* COST-6: an estimate is never presented as a
                        measurement. */}
                    {course.estimatedCostMicros > 0 &&
                      ' · includes an estimate'}
                  </p>
                </div>
                {course.bySurface.length > 0 && (
                  <div className="text-xs text-neutral-400">
                    <p>By surface:</p>
                    <BySurfaceList
                      bySurface={course.bySurface}
                      className="list-disc pl-5"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="Students approaching their limit today"
        className="flex flex-col gap-2"
      >
        <h2 className="text-lg font-semibold text-neutral-900">
          Students approaching their limit today
        </h2>
        {report && report.studentsNearLimit.length === 0 && (
          <p className="text-sm text-neutral-500">
            Nobody is close to a course's own daily limit today.
          </p>
        )}
        {report && report.studentsNearLimit.length > 0 && (
          <ul className="flex flex-col gap-2">
            {report.studentsNearLimit.map((entry) => (
              <li
                key={`${entry.courseId}-${entry.personId}`}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 p-3"
              >
                <div>
                  <p className="text-sm font-medium text-neutral-900">
                    {studentLabel(entry)}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {entry.courseTitle}
                  </p>
                </div>
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
