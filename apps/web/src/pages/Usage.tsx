/**
 * COST-3/COST-4 — an instructor's own usage screen: what their courses have
 * spent, which students are approaching a course's own daily limit today,
 * and the organization's own spending cap, settable (or clearable) right
 * here.
 *
 * An audit (`docs/ROADMAP.md`'s "Audit — surfaces that were never built")
 * found both halves of this screen missing entirely: `costLedger.organizationUsage`
 * (`@bloombot/actions`) has existed since the COST-1..6 slice, but its only
 * caller was `apps/mcp`'s own tool surface — nothing in this panel ever
 * called it, so an instructor had no way to see their own courses' spend
 * without reading a log or running a query, exactly what COST-4's own text
 * says must not be true. `organizations.setSpendingCap` (`@bloombot/db`)
 * had zero non-test callers anywhere in the monorepo — COST-3's enforcement
 * (`@bloombot/core#answer.ts`) was real, but the cap it enforces could
 * never be set outside a test. `api/client.ts#fetchOrganizationUsage`/
 * `setSpendingCap` and `costLedger.setSpendingCap` (`@bloombot/actions`,
 * this same slice's own addition) are what close both gaps; this component
 * is what a caller actually sees.
 *
 * **Three visually distinct states for the cap**, not a shared "here is a
 * number" treatment — COST-3's own enforcement stops the assistant
 * answering the moment a cap is reached, so an instructor reading this
 * screen needs "no cap at all," "a cap that has room left," and "a cap that
 * has stopped the assistant" to look nothing alike, not merely differ by a
 * word. "Cap reached" is derived here from the same comparison
 * `@bloombot/db`'s own `hasReachedSpendingCap` makes (`spent >= cap`) —
 * this screen's own read (`getOrganizationUsageSummary`) already carries
 * both numbers, so there is no second request to make just to ask the
 * question this file already has the two halves of.
 *
 * **Setting a cap is owner-only, and this screen does not wait to find
 * that out by trying.** `isOwner` (a prop, computed once in
 * `pages/Shell.tsx` from the caller's own membership) decides whether the
 * cap form renders at all — the same `isMember`/tab shape `Shell.tsx`
 * already uses for Discord/Projects/Transcripts: the *server's* own check
 * (`costLedger.setSpendingCap`'s `execute`, restricted to an owner) is what
 * actually enforces this; withholding the control here only avoids
 * offering a caller a click every attempt through which would refuse.
 *
 * **No email, ever.** `studentsNearLimit` shows `personDisplayName ??
 * personId` — the same fallback `components/CoursePeople.tsx#label`
 * already uses, for the same reason its own module comment gives: a
 * `null` display name is already told apart from another by a distinct id,
 * and these are real students' addresses, shown only where a screen
 * genuinely cannot tell two people apart without one, which is not the
 * case here.
 *
 * WEB-63 — the fetch (`useOrganizationUsageReport`) and the small format
 * helpers below it (`formatMicros`/`formatBySurface`/`studentLabel`) are
 * shared with the course editor's own Usage tab
 * (`components/CourseUsage.tsx`), which filters this same organization-wide
 * report down to one course rather than reading a second, course-scoped
 * action that does not exist.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, setSpendingCap } from '../api/client.js'
import type { OrganizationUsageReport } from '../api/types.js'
import { Button } from '../components/Button.js'
import { ErrorMessage } from '../components/ErrorMessage.js'
import { FormField } from '../components/FormField.js'
import { textInputClasses } from '../components/fieldStyles.js'
import {
  formatBySurface,
  formatMicros,
  studentLabel,
} from '../components/usageFormat.js'
import { useOrganizationUsageReport } from '../hooks/useOrganizationUsage.js'
import type { TabDirtyActions } from '../hooks/tabDirtyActions.js'
import { InfoIcon, WarningIcon } from '../icons.js'

export interface UsageScreenProps {
  organizationId: string
  /** Whether the caller's own membership in this organization is `'owner'` — see this file's own module comment for why the form is withheld rather than merely disabled for anyone else. */
  isOwner: boolean
  /**
   * WEB-69 — called on every change to whether this screen's own cap input
   * currently disagrees with the last-saved cap, so
   * `pages/OrganizationSettings.tsx` can fold it into that tab's own dirty
   * flag (the same `onDirtyChange` shape `components/CourseInstructions.tsx`
   * already exposes `pages/CourseEditor.tsx`, one level up). Optional,
   * defaulting to a no-op — most of this file's own tests do not care.
   */
  onDirtyChange?: (dirty: boolean) => void
  /** WEB-69 — this tab's own save/discard handle, the same `onRegisterActions` shape `components/CourseInstructions.tsx` already exposes; called with `null` on unmount. Optional — most of this file's own tests do not care. */
  onRegisterActions?: (actions: TabDirtyActions | null) => void
}

/**
 * A cap amount, typed as a currency amount ($12.50), never micros. Blank
 * means "clear the cap" (`null`); anything else must parse as a nonnegative
 * amount with at most two decimal places (cents) — never `NaN`, which would
 * silently be sent as `null` and clear the stored cap instead of refusing,
 * the same failure `pages/CourseEditor.tsx#parseMaxRequestsPerDay`'s own
 * doc comment names for the identical shape.
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

/** `capInput`'s own starting value for a freshly loaded (or refreshed) report — the stored cap, formatted the same way `formatMicros` renders it but without the `$`, since this feeds an editable field rather than read-only text. */
function capInputFromReport(report: OrganizationUsageReport): string {
  return report.spendingCapMicros === null
    ? ''
    : (report.spendingCapMicros / 1_000_000).toFixed(2)
}

export function Usage({
  organizationId,
  isOwner,
  onDirtyChange = () => {},
  onRegisterActions,
}: UsageScreenProps) {
  // WEB-63 — the fetch itself is shared with the course tab's own
  // `CourseUsage` (this file's own module comment); `refresh` is re-run
  // below after a cap save/clear, the same as before this extraction.
  const {
    report,
    loadError,
    refresh: refreshReport,
  } = useOrganizationUsageReport(organizationId)
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
  // after a save or a clear succeeds. Cleared on every new attempt so a
  // stale announcement never lingers alongside a fresh error — the same
  // `statusMessage` shape `components/CoursePeople.tsx` already uses for
  // ENRL-6/ENRL-9's identical async-status need.
  const [statusMessage, setStatusMessage] = useState<string | undefined>(
    undefined
  )

  // `capInput`'s own starting value tracks the loaded (or refreshed) report
  // — the same "seeded from a fresh report" timing the old, page-local
  // fetch used to do inline; kept as its own effect now that the fetch
  // itself lives in `useOrganizationUsageReport`; below.
  useEffect(() => {
    if (report) setCapInput(capInputFromReport(report))
  }, [report])

  // WEB-69: returns whether the cap actually saved, so a caller that saves
  // on the way somewhere else (`pages/OrganizationSettings.tsx`'s own tab
  // prompt, via `onRegisterActions`) knows whether it is safe to move on —
  // the same `Promise<boolean>` shape `pages/CourseEditor.tsx#handleSave`
  // already returns for the identical reason. A `useCallback`, like
  // `components/CourseInstructions.tsx#handleSave` — it is handed out
  // through `onRegisterActions`, below, so its own identity has to change
  // whenever anything it closes over does, which is what keeps the
  // registered action fresh rather than a stale closure over an earlier
  // `capInput`.
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
  // report this screen actually saw, the same comparison
  // `capInputFromReport` already makes to seed the field in the first
  // place. `undefined` while nothing has loaded yet reads as "not dirty" —
  // there is no saved cap yet to disagree with.
  const isDirty =
    report !== undefined && capInput !== capInputFromReport(report)

  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  // WEB-69 — handed out through `onRegisterActions`, the same
  // `useCallback`-per-render discipline `components/CourseInstructions.tsx#handleSave`
  // already holds itself to: a new identity every render would re-run the
  // registration effect below on every keystroke.
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

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-page-title font-semibold text-neutral-900">
          Usage
        </h1>
        <ErrorMessage error={loadError} />
      </div>
    )
  }

  // COST-3: the same comparison `@bloombot/db`'s own `hasReachedSpendingCap`
  // makes (`spent >= cap`) — this file's own module comment has why it is
  // safe to derive here rather than a second request.
  const capReached =
    report !== undefined &&
    report.spendingCapMicros !== null &&
    report.totalCostMicros >= report.spendingCapMicros

  return (
    <div className="flex flex-col gap-6" data-testid="usage-screen">
      <h1 className="text-page-title font-semibold text-neutral-900">Usage</h1>

      <p role="status" className="sr-only">
        {statusMessage}
      </p>

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
          // the same shape `pages/Admin.tsx#ProcessBadge` already uses.
          // Two elements (this `<div>` and a nested `<span>`) with
          // byte-identical `textContent` is exactly the shape a text-based
          // locator (`e2e/spending-cap.spec.ts#readCapMicros`'s own
          // `page.getByText`) cannot tell apart without an explicit
          // `exact`/scope — one element per distinct message avoids the
          // ambiguity outright rather than working around it in the test.
          <div className="flex items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-800">
            <InfoIcon aria-hidden="true" className="size-4 shrink-0" />
            Cap set at {formatMicros(report.spendingCapMicros)} —{' '}
            {formatMicros(report.totalCostMicros)} spent so far.
          </div>
        )}
        {report && capReached && report.spendingCapMicros !== null && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-danger-600 bg-danger-50 px-3 py-2 text-sm text-danger-700"
          >
            <WarningIcon aria-hidden="true" className="size-4 shrink-0" />
            Cap reached — {formatMicros(report.totalCostMicros)} of{' '}
            {formatMicros(report.spendingCapMicros)} spent. The assistant will
            not answer until this is raised or cleared.
          </div>
        )}
        {report && report.bySurface.length > 0 && (
          // COST-7 — the organization's own total above, broken down by
          // surface: the same terse register the total itself uses, not a
          // second table.
          <p className="text-sm text-neutral-500">
            By surface: {formatBySurface(report.bySurface)}
          </p>
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
                  <p className="text-sm font-medium text-neutral-900">
                    {course.courseTitle}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {formatMicros(course.costMicros)} · {course.callCount}{' '}
                    {course.callCount === 1 ? 'call' : 'calls'}
                    {/* COST-6: an estimate is never presented as a
                        measurement — said plainly whenever any part of this
                        course's own total came from one. */}
                    {course.estimatedCostMicros > 0 &&
                      ' · includes an estimate'}
                  </p>
                </div>
                {course.bySurface.length > 0 && (
                  // COST-7 — this course's own total above, broken down by
                  // surface: the same terse register the total itself uses.
                  <p className="text-xs text-neutral-400">
                    By surface: {formatBySurface(course.bySurface)}
                  </p>
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
