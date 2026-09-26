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
