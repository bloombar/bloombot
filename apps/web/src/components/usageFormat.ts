/**
 * COST-4/COST-6/COST-7/WEB-63 — the small, pure formatting helpers
 * `pages/Usage.tsx` and `components/CourseUsage.tsx` (WEB-63's own course
 * tab) both need to render the same figures the same way. Extracted here so
 * the two screens read a spend, a per-surface breakdown and a near-limit
 * student label identically, rather than each keeping its own copy that
 * could drift apart one edit at a time.
 */

import { fullName } from '../person-identity.js'
import type { CostBySurface } from '../api/types.js'
import { surfaceLabel } from '../surface-label.js'

/** Integer micros (COST-1) to a plain dollar figure. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/**
 * COST-7 — one surface's own entry: label, cost, call count and an
 * "(includes an estimate)" note when any part of it is an estimate. What
 * `components/BySurfaceList.tsx` renders one `<li>` per entry with.
 */
export function formatBySurfaceEntry(entry: CostBySurface): string {
  const calls = entry.callCount === 1 ? 'call' : 'calls'
  const estimateNote =
    entry.estimatedCostMicros > 0 ? ' (includes an estimate)' : ''
  return `${surfaceLabel(entry.surface)}: ${formatMicros(entry.costMicros)} · ${entry.callCount} ${calls}${estimateNote}`
}

/**
 * A person a Usage screen names, in place of a name — the shared fallback
 * `pages/Usage.tsx`'s `studentsNearLimit` rows and its own Student filter
 * (`components/UsageFilterRow.tsx`) both need: a display name, then a full
 * name built from first/last, then the bare id — never an email (this
 * screen's own long-standing rule; see `docs/DECISIONS.md`'s WEB-78 entry).
 * A plain object, not `UsageNearLimit`/`OrganizationUsagePerson` by name,
 * since both `api/types.ts` interfaces already carry every field this
 * needs and nothing this ignores.
 */
export interface StudentLabelFields {
  personId: string
  personDisplayName: string | null
  personFirstName: string | null
  personLastName: string | null
}

export function studentLabel(entry: StudentLabelFields): string {
  return (
    entry.personDisplayName ??
    fullName({
      personFirstName: entry.personFirstName,
      personLastName: entry.personLastName,
    }) ??
    entry.personId
  )
}
