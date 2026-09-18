/**
 * ADMIN-7..ADMIN-11 — the console screens' own shared formatting and
 * building blocks, pulled out of the single `pages/Admin.tsx` module this
 * slice's own brief calls for splitting up. Nothing here is new behaviour:
 * `formatMicros`/`formatBySurface`/`ReadOnlyField` are unchanged from
 * `pages/Admin.tsx`'s own pre-split versions, moved here so every one of
 * the per-screen modules in this directory can `import` them rather than
 * each holding its own copy.
 */

import type { CostBySurface } from '../../api/types.js'
import { surfaceLabel } from '../../surface-label.js'

/** Integer micros (COST-1) to a plain dollar figure — the same unit `costLedger`'s own summaries use platform-wide. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/** COST-7 — the same terse, inline register this console's own per-organization total already uses ("$1.00 spent · 3 call(s) · partly estimated"), applied per surface. */
export function formatBySurface(bySurface: CostBySurface[]): string {
  return bySurface
    .map((entry) => {
      const estimateNote =
        entry.estimatedCostMicros > 0 ? ' · partly estimated' : ''
      return `${surfaceLabel(entry.surface)}: ${formatMicros(entry.costMicros)} · ${entry.callCount} call(s)${estimateNote}`
    })
    .join(' · ')
}

/**
 * ADMIN-6/ADMIN-7..11 — a label/value pair rendered as plain text, never a
 * control a person can type into: every console screen's "nothing editable"
 * discipline, so every setting or fact below is a `<dt>`/`<dd>` pair, not a
 * disabled `<input>` — a disabled input still renders as a textbox to
 * assistive technology and to a test asserting "nothing editable" by role,
 * where a plain paragraph does not. Every caller wraps a run of these in a
 * `<dl>` — this component renders only the one pair, not the list ancestor.
 */
export function ReadOnlyField({
  label,
  value,
  multiline = false,
}: {
  label: string
  value: string
  multiline?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="w-48 shrink-0 text-xs font-medium text-neutral-500">
        {label}
      </dt>
      <dd
        className={
          multiline
            ? 'whitespace-pre-wrap text-sm text-neutral-900'
            : 'text-sm text-neutral-900'
        }
      >
        {value}
      </dd>
    </div>
  )
}
