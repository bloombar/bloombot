/**
 * WEB-77/WEB-78 — the per-surface breakdown `pages/Usage.tsx` and
 * `components/CourseUsage.tsx` both render, as a `<ul>` (one `<li>` per
 * surface) rather than one run-on line joined by ` · ` — a list is what
 * lets a screen reader (and a reader scanning quickly) tell three surfaces
 * apart without parsing a sentence. The admin console's own pages
 * (`pages/admin/*`) render their own, entirely separate inline line
 * (`pages/admin/shared.tsx#formatBySurface`) — a different function, not
 * this file's own `formatBySurfaceEntry`, so this component's own rework
 * never touched them.
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
