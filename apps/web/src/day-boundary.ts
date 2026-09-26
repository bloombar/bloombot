/**
 * WEB-77 — extracted from `components/TranscriptBrowser.tsx`, which used to
 * keep its own copy of these two functions: the Usage screens' own date
 * filters (`pages/Usage.tsx`, `components/CourseUsage.tsx`) need the
 * identical `<input type="date">` value → epoch-milliseconds boundary the
 * Transcripts filter already computes, and a second, separately maintained
 * copy is exactly the kind of drift `person-identity.ts`'s own module
 * comment already warns against for a shared rule.
 */

/** A `<input type="date">` value's own start-of-day boundary, in epoch milliseconds, in the browser's own local timezone — `undefined` for an empty picker, so an unset filter is genuinely omitted rather than sent as `NaN`. */
export function dayStart(value: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(`${value}T00:00:00`)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** The same value's own end-of-day boundary, in epoch milliseconds. */
export function dayEnd(value: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(`${value}T23:59:59.999`)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Round 2, must-fix 3 — the same nonnegative check
 * `costLedger.organizationUsage`'s own input schema
 * (`packages/actions/src/actions/cost-ledger.ts`) already makes of `from`/
 * `to`, run here first so a date before 1 January 1970 (a negative epoch)
 * or a "From" after "To" never reaches the server at all. A request the
 * server refused used to fail zod's `nonnegative()` check and replace the
 * whole screen with `<ErrorMessage>`, the filter row that caused it gone
 * along with everything else — checked here instead, named right next to
 * the fields that caused it.
 */
export function dateRangeError(
  startDate: string,
  endDate: string
): string | undefined {
  const startAt = dayStart(startDate)
  const endAt = dayEnd(endDate)
  if (
    (startAt !== undefined && startAt < 0) ||
    (endAt !== undefined && endAt < 0)
  ) {
    return 'Dates must be on or after 1 January 1970.'
  }
  if (startAt !== undefined && endAt !== undefined && startAt > endAt) {
    return '"From" must be on or before "To".'
  }
  return undefined
}
