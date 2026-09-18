/**
 * COST-4/COST-6/COST-7/WEB-63 — the small, pure formatting helpers
 * `pages/Usage.tsx` and `components/CourseUsage.tsx` (WEB-63's own course
 * tab) both need to render the same figures the same way. Extracted here so
 * the two screens read a spend, a per-surface breakdown and a near-limit
 * student label identically, rather than each keeping its own copy that
 * could drift apart one edit at a time.
 */

import type { CostBySurface, UsageNearLimit } from '../api/types.js'
import { surfaceLabel } from '../surface-label.js'

/** Integer micros (COST-1) to a plain dollar figure. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/**
 * COST-7 — a terse, inline "By surface: ..." line, one entry per surface
 * `bySurface` carries (at most `discord`/`web`/`mcp`/`unknown`), joined with
 * ` · ` so this reads as a short list rather than a wall of text.
 */
export function formatBySurface(bySurface: CostBySurface[]): string {
  return bySurface
    .map((entry) => {
      const calls = entry.callCount === 1 ? 'call' : 'calls'
      const estimateNote =
        entry.estimatedCostMicros > 0 ? ' (includes an estimate)' : ''
      return `${surfaceLabel(entry.surface)}: ${formatMicros(entry.costMicros)} · ${entry.callCount} ${calls}${estimateNote}`
    })
    .join(' · ')
}

/** What a near-limit row shows in place of a name — `personDisplayName` when the person has one, `personId` otherwise (never an email — `pages/Usage.tsx`'s own module comment on why). */
export function studentLabel(entry: UsageNearLimit): string {
  return entry.personDisplayName ?? entry.personId
}
