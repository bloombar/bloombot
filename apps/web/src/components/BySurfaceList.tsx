/**
 * WEB-77/WEB-78 — the per-surface breakdown `pages/Usage.tsx` and
 * `components/CourseUsage.tsx` both render, as a `<ul>` (one `<li>` per
 * surface) rather than the single terse inline line `usageFormat.ts#formatBySurface`
 * used to render there. A list is what lets a screen reader (and a reader
 * scanning quickly) tell three surfaces apart without parsing a run-on
 * sentence joined by ` · ` — the admin console's own pages
 * (`pages/admin/*`) keep the inline line, which is why `formatBySurface`
 * itself still exists rather than being removed outright.
 */

import type { CostBySurface } from '../api/types.js'
import { formatBySurfaceEntry } from './usageFormat.js'

export interface BySurfaceListProps {
  bySurface: CostBySurface[]
  className?: string
}

export function BySurfaceList({ bySurface, className }: BySurfaceListProps) {
  if (bySurface.length === 0) return null
  return (
    <ul className={className}>
      {bySurface.map((entry) => (
        <li key={entry.surface}>{formatBySurfaceEntry(entry)}</li>
      ))}
    </ul>
  )
}
